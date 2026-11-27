// priv —— 经 cccodroid 应用进程里的 Shizuku binder，以 shell 身份（uid 2000）执行命令。
// 协议见 android/java/ha/chi/mia/Priv.java。
import net from "node:net";

// 私有目录里的文件套接字：别的应用抢不走（以前的抽象套接字 \0ha.chi.mia.priv 谁都能先绑 —— 审查 H2）
const SOCKET = process.env.CCAPP_PRIV_SOCK || "/data/data/ha.chi.mia/files/.priv.sock";
const args = process.argv.slice(2);
const HELP = `用法:
  priv '<命令>'           以 shell 身份执行（/system/bin/sh -c）
  priv -- <程序> [参数…]   不经 sh，直接执行
  priv --status           Shizuku 状态
  priv --request          弹出 Shizuku 授权请求
  priv --keepalive on|off 后台保活增强（幽灵进程上限、电池白名单等）
标准输入会转给命令；退出码与命令一致。`;

const MAX_RESP = 4 << 20;
const DEFAULT_TIMEOUT_MS = Number(process.env.CCAPP_PRIV_TIMEOUT_MS) > 0 ? Number(process.env.CCAPP_PRIV_TIMEOUT_MS) : 20000;

function oneShot(req, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: SOCKET }, () => s.write(JSON.stringify(req) + "\n"));
    s.setEncoding("utf8");
    let buf = "", bytes = 0, settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      s.setTimeout(0);
      if (err) reject(err);
      else resolve(val);
    };
    s.setTimeout(timeoutMs, () => { s.destroy(); finish(new Error("超时")); });
    s.on("data", (d) => {
      bytes += Buffer.byteLength(d);
      if (bytes > MAX_RESP) {
        s.destroy();
        finish(new Error("回应过大"));
        return;
      }
      buf += d;
    });
    s.on("end", () => {
      if (settled) return;
      try { finish(null, JSON.parse(buf)); } catch { finish(new Error("回应无法解析：" + buf.slice(0, 200))); }
    });
    s.on("error", (e) => finish(e));
    s.on("close", () => finish(new Error("连接已关闭")));
  });
}

function exec(argv) {
  // shell 进不了本应用的私有目录，工作目录只在共享存储时沿用
  const cwd = /^\/(sdcard|storage)\//.test(process.cwd()) ? process.cwd() : "/";
  const s = net.connect({ path: SOCKET }, () => {
    s.write(JSON.stringify({ op: "exec", argv, cwd }) + "\n");
    const frame = (type, b) => {
      const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(b.length, 1);
      s.write(Buffer.concat([h, b]));
    };
    if (process.stdin.isTTY) frame(0, Buffer.alloc(0));
    else {
      process.stdin.on("data", (d) => frame(0, d));
      process.stdin.on("end", () => frame(0, Buffer.alloc(0)));
      process.stdin.on("error", () => frame(0, Buffer.alloc(0)));
    }
  });
  let buf = Buffer.alloc(0), connected = false, gotExit = false;
  s.on("connect", () => { connected = true; });
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const type = buf[0], len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (type === 1) process.stdout.write(body);
      else if (type === 2) process.stderr.write(body);
      else if (type === 4) process.stderr.write("priv: " + body.toString() + "\n");
      else if (type === 3) { gotExit = true; process.exitCode = body.readInt32BE(0); s.destroy(); process.stdin.destroy(); }
    }
  });
  // 连上之后的写错误（对端先结束了，我们还在递 stdin）不算失败 —— 回应可能已经在缓冲里，等 close 时再判断
  s.on("error", (e) => {
    if (connected) return;
    process.stderr.write(`priv: 连不上 cccodroid（${e.code || e.message}）。应用的后台服务在运行吗？\n`);
    process.exit(125);
  });
  s.on("close", () => {
    if (!gotExit) { process.stderr.write("priv: 连接中断，没有收到退出码\n"); process.exitCode = 125; }
    process.stdin.destroy();
  });
}

if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(args.length ? 0 : 2); }
try {
  if (args[0] === "--status") console.log(JSON.stringify(await oneShot({ op: "status" }), null, 2));
  else if (args[0] === "--request") console.log((await oneShot({ op: "request" }, Number(process.env.CCAPP_PRIV_TIMEOUT_MS) > 0 ? Number(process.env.CCAPP_PRIV_TIMEOUT_MS) : 60000)).message);
  else if (args[0] === "--keepalive") console.log(JSON.stringify(await oneShot({ op: "keepalive", enable: args[1] !== "off" }), null, 2));
  else if (args[0] === "--") exec(args.slice(1));
  else exec(["/system/bin/sh", "-c", args.join(" ")]);
} catch (e) {
  process.stderr.write(`priv: ${e.message}\n`);
  process.exit(125);
}
