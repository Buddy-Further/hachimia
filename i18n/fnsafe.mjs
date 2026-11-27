// 译文里以 @ 开头的行是一段 JS（复数之类，见 mkdict.mjs），会原样写进 lang-*.js、在界面里执行。
// 外部 PR 往译文里塞一行代码就能在界面里跑（拿得到网关令牌），所以只放行现有这几种形状：
//   (v) => `…${v.n}…`、三元 / 比较 / 取余、字符串、String(v.n)、俄语那种 const f = (a, b, c) => …; return …
// 只许读 v 的一层属性（v.n、v.path…），不许方括号、反斜杠、别的全局名。mkdict 生成时和 pr-guard 审 PR 时都用它。
// 不变式：v 永远是纯数据（i18n.js 里 v(vars || {}) 传的插值对象）。形状里允许 v.x(…)，靠的就是这一条——
// 哪天往插值里塞函数或带方法的对象，这里就得一起收紧。
const IDS = new Set(["v", "String", "const", "return", "f", "a", "b", "c"]);
const BAD_PROP = new Set([
  "constructor", "prototype", "__proto__", "valueOf", "toString",
  "call", "apply", "bind", "caller", "arguments",
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
]);

function checkExpr(expr, allowBraces) {
  const re = allowBraces ? /^[\w .()=>?:!<+\-*/%&|,;{}"]*$/ : /^[\w .()=>?:!<+\-*/%&|,;"]*$/;
  if (!re.test(expr)) return "有不允许的字符";
  if (/\/[/*]/.test(expr)) return "不许注释";
  // 点号只能出现在 v.<属性> 里，属性名是普通小写单词
  for (const m of expr.matchAll(/\./g)) {
    const before = expr.slice(0, m.index), after = expr.slice(m.index + 1);
    const prop = (/^([a-z][a-zA-Z]{0,15})\b/.exec(after) || [])[1];
    if (!/(^|[^\w$])v\s*$/.test(before) || !prop || BAD_PROP.has(prop)) return "只许读 v 的一层属性";
  }
  const noProps = expr.replace(/\bv\s*\.\s*[a-z][a-zA-Z]*/g, "v");
  for (const m of noProps.matchAll(/[A-Za-z_][\w]*/g)) {
    if (!IDS.has(m[0])) return "不认识的名字 " + m[0];
  }
  return "";
}

function readDoubleString(s, start) {
  let j = start + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"') return { next: j + 1, err: "" };
    if (ch === "\\" || ch === "[" || ch === "]" || ch === "$") return { err: "不许反斜杠、方括号、$" };
    if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") return { err: "引号没配对" };
    j++;
  }
  return { err: "引号没配对" };
}

function readTemplate(s, start) {
  let j = start + 1;
  const ex = [];
  while (j < s.length) {
    const ch = s[j];
    if (ch === "`") {
      return { next: j + 1, skel: "(" + (ex.length ? ex.join("+") : '""') + ")", err: "" };
    }
    if (ch === "\\" || ch === "[" || ch === "]") return { err: "不许反斜杠、方括号、$" };
    if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") return { err: "引号没配对" };
    if (ch === "$") {
      if (s[j + 1] !== "{") return { err: "不许反斜杠、方括号、$" };
      let k = j + 2;
      let exprSkel = "";
      while (k < s.length) {
        const c2 = s[k];
        if (c2 === "}") break;
        if (c2 === "{") return { err: "模板里有没配对的花括号" };
        if (c2 === "`") return { err: "模板表达式不许嵌套模板" };
        if (c2 === "'") return { err: "引号没配对" };
        if (c2 === "\\" || c2 === "[" || c2 === "]" || c2 === "$") return { err: "不许反斜杠、方括号、$" };
        if (c2 === "\n" || c2 === "\r" || c2 === "\u2028" || c2 === "\u2029") return { err: "有不允许的字符" };
        if (c2 === '"') {
          const str = readDoubleString(s, k);
          if (str.err) return { err: str.err };
          exprSkel += '""';
          k = str.next;
          continue;
        }
        exprSkel += c2;
        k++;
      }
      if (k >= s.length || s[k] !== "}") return { err: "模板里有没配对的花括号" };
      if (!exprSkel.trim()) return { err: "模板表达式不能为空" };
      const prob = checkExpr(exprSkel, false);
      if (prob) return { err: prob };
      ex.push(exprSkel);
      j = k + 1;
      continue;
    }
    j++;
  }
  return { err: "引号没配对" };
}

/** 这段（不含开头的 @）是不是放行的形状；不是就返回原因 */
export function i18nFnProblem(src) {
  const s = String(src);
  if (!s.startsWith("(v) => ")) return "要以 (v) => 开头";
  let skel = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      const str = readDoubleString(s, i);
      if (str.err) return str.err;
      skel += '""';
      i = str.next;
      continue;
    }
    if (ch === "`") {
      const tpl = readTemplate(s, i);
      if (tpl.err) return tpl.err;
      skel += tpl.skel;
      i = tpl.next;
      continue;
    }
    if (ch === "'") return "引号没配对";
    if (ch === "\\" || ch === "[" || ch === "]" || ch === "$") return "不许反斜杠、方括号、$";
    skel += ch;
    i++;
  }
  return checkExpr(skel, true);
}
