#!/bin/sh
# Java 侧的纯逻辑回归（不依赖安卓运行时）：Ed25519 验签向量、特权命令确认规则、硬件密钥认证验链。
# 编译产物放私有缓存目录，不进仓库。用法：sh scripts/java-tests.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${TMPDIR:-$HOME/.cache}/hachimia-java-tests
rm -rf "$OUT"; mkdir -p "$OUT"
javac -nowarn -d "$OUT" "$ROOT/android/tests/stub/android/util/Base64.java" "$ROOT/android/java/ha/chi/mia/Ed25519.java" "$ROOT/android/tests/ha/chi/mia/Ed25519Vectors.java"
java -cp "$OUT" ha.chi.mia.Ed25519Vectors
javac -nowarn -d "$OUT" "$ROOT/android/java/ha/chi/mia/PrivRules.java" "$ROOT/android/tests/ha/chi/mia/PrivRulesTest.java"
java -cp "$OUT" ha.chi.mia.PrivRulesTest
javac -nowarn -d "$OUT" "$ROOT/android/java/ha/chi/mia/KeyAttest.java" "$ROOT/android/tests/ha/chi/mia/KeyAttestTest.java"
java -cp "$OUT" ha.chi.mia.KeyAttestTest
# 更新说明挑版本：WhatsNew 引了安卓类，编译要 android.jar（平板 ~/.bldtools，或 ANDROID_JAR）；pick 本身不碰安卓接口
AJAR=${ANDROID_JAR:-$HOME/.bldtools/android.jar}
if [ ! -f "$AJAR" ]; then
  for SDKD in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /usr/local/lib/android/sdk; do
    [ -d "$SDKD/platforms" ] || continue
    CAND=$(ls -1 "$SDKD"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$CAND" ] && [ -f "$CAND" ]; then AJAR="$CAND"; break; fi
  done
fi
if [ -f "$AJAR" ]; then
  javac -nowarn -d "$OUT" -cp "$AJAR:$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')" $(find "$ROOT/android/java" -name '*.java') "$ROOT/android/tests/ha/chi/mia/WhatsNewPickTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.WhatsNewPickTest
  # 第二份稳定性报告 l 组（BUG-A01/A02/A03/A04/A05 的纯逻辑；只调基本类型判断，不碰安卓运行时）
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/Stab2LHostTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.Stab2LHostTest
  # 05-工具包重装丢组件：同一版重装时组件自己 dpkg 包清单里的文件要跟着搬（只造 MANIFEST，不碰 org.json）
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/InstallerCarryTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.InstallerCarryTest
  # MIG-31（fix-G 跟进 #2）：GatewaySquattedTest 之前只手动跑过，未接入 CI 入口
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/GatewaySquattedTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.GatewaySquattedTest
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/A11yProtectedPackageTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.A11yProtectedPackageTest
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/UpdaterDevkitStagedTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.UpdaterDevkitStagedTest
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/ha/chi/mia/Wave3SecurityTest.java"
  java -cp "$OUT:$AJAR" ha.chi.mia.Wave3SecurityTest
else echo "跳过 WhatsNewPickTest（没有 android.jar）"; fi
