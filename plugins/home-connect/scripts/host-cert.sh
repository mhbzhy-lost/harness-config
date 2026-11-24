#!/usr/bin/env bash
# 宿主模式中继路的 TLS 证书：自建 CA + 叶证书。TLS 在本机终结，中继（frp）只转发密文，
# 与 stdio 版 SSH 端到端加密同级。手机端需安装 ca.crt 才会信任（与 pi-relay 做法相同）。
# 用法：host-cert.sh <输出目录> <中继公网IP> <本机局域网IP>
# 叶证书有效期 825 天；到期重跑本脚本会换新 CA，手机需重装。
set -euo pipefail
OUT="${1:?用法: host-cert.sh <输出目录> <中继公网IP> <局域网IP>}"
RELAY_IP="${2:?缺少中继公网 IP}"
LAN_IP="${3:?缺少局域网 IP}"
for ip in "$RELAY_IP" "$LAN_IP"; do
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "不是合法 IPv4: $ip" >&2; exit 2; }
done
umask 077
mkdir -p "$OUT"
# 用 RSA 而不是 EC：macOS 自带 LibreSSL 的 `-newkey ec -pkeyopt ec_paramgen_curve` 会生成
# 「显式曲线参数」的公钥，OpenSSL 3 / LibreSSL 客户端一律报 explicit ECC parameters 拒绝握手。
newkey=(-newkey rsa:2048 -nodes)
openssl req -x509 "${newkey[@]}" -days 3650 -subj "/CN=home-connect-host-ca" \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt"
openssl req "${newkey[@]}" -subj "/CN=home-connect-host" -keyout "$OUT/server.key" -out "$OUT/server.csr"
ext="$(mktemp)"; trap 'rm -f "$ext"' EXIT
cat >"$ext" <<EOF
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${LAN_IP},IP:${RELAY_IP}
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
  -days 825 -sha256 -extfile "$ext" -out "$OUT/server.crt"
rm -f "$OUT/server.csr"
chmod 600 "$OUT"/*.key
echo "CA 证书（装到手机）: $OUT/ca.crt"
openssl x509 -in "$OUT/ca.crt" -noout -fingerprint -sha256
# 展示用 -text（macOS 自带的 LibreSSL 3.3 没有 x509 -ext）
openssl x509 -in "$OUT/server.crt" -noout -enddate -text | grep -E 'NotAfter|Subject Alternative Name' -A1 | grep -v '^--'
