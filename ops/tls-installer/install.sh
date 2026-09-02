#!/bin/bash -p
set -euo pipefail

readonly domain=firesidechat.cn
readonly live_dir=/etc/fireside-tls
readonly nginx_config=/etc/fireside-nginx/nginx.conf
readonly unit=fireside-https.service
readonly trust_store=/etc/ssl/certs/ca-certificates.crt

fail() {
  echo "$1" >&2
  exit 2
}

[[ ${EUID} -eq 0 ]] || fail 'fireside TLS installer requires root'
[[ $# -eq 2 ]] || fail 'usage: fireside-tls-install <fullchain.pem> <privkey.pem>'
readonly certificate_source=$1
readonly private_key_source=$2
[[ ${certificate_source} == /* && ${private_key_source} == /* ]] \
  || fail 'TLS source paths must be absolute'
[[ ${certificate_source} != "${private_key_source}" ]] || fail 'certificate and private key sources must differ'

validate_source() {
  local source=$1
  local expected_mode=$2
  local label=$3
  [[ -f ${source} && ! -L ${source} ]] || fail "${label} source must be a regular non-symlink file"
  local metadata
  metadata=$(stat -c '%u:%g:%a:%h' -- "${source}")
  local owner_group mode links
  IFS=: read -r owner_group mode links <<<"${metadata#*:}"
  # Parse the full form separately to avoid ever reading or printing file content.
  [[ $(stat -c '%u:%g' -- "${source}") == 0:0 ]] || fail "${label} source must be root-owned"
  [[ $(stat -c '%h' -- "${source}") == 1 ]] || fail "${label} source must have one hard link"
  if [[ ${expected_mode} == private ]]; then
    [[ $(stat -c '%a' -- "${source}") == 600 ]] || fail 'private key source mode must be 0600'
  else
    case $(stat -c '%a' -- "${source}") in
      600|640|644) ;;
      *) fail 'certificate source mode must be 0600, 0640, or 0644' ;;
    esac
  fi
}

validate_source "${certificate_source}" certificate certificate
validate_source "${private_key_source}" private 'private key'
[[ -d ${live_dir} && ! -L ${live_dir} && $(stat -c '%u:%g:%a' -- "${live_dir}") == 0:0:700 ]] \
  || fail 'TLS live directory metadata is invalid; run the host HTTPS layout installer first'
[[ -f ${nginx_config} && ! -L ${nginx_config} && $(stat -c '%u:%g:%a:%h' -- "${nginx_config}") == 0:0:644:1 ]] \
  || fail 'Fireside Nginx configuration metadata is invalid'
[[ -r ${trust_store} ]] || fail 'system CA trust store is unavailable'

umask 077
work=$(mktemp -d "${live_dir}/.install.XXXXXX")
chmod 0700 "${work}"
cleanup() {
  rm -rf -- "${work}"
}
trap cleanup EXIT HUP INT TERM

readonly staged_certificate=${work}/fullchain.pem
readonly staged_private_key=${work}/privkey.pem
sed -e 's/\r$//' -e 's/^[[:blank:]]*//' -- "${certificate_source}" >"${staged_certificate}"
sed -e 's/\r$//' -e 's/^[[:blank:]]*//' -- "${private_key_source}" >"${staged_private_key}"
chmod 0644 "${staged_certificate}"
chmod 0600 "${staged_private_key}"

readonly certificate_begin='-----BEGIN ''CERTIFICATE-----'
grep -Fxq "${certificate_begin}" "${staged_certificate}" \
  || fail 'certificate source does not contain a PEM server certificate'
! grep -q 'CERTIFICATE REQUEST' "${staged_certificate}" \
  || fail 'a certificate request cannot be installed as a server certificate'
grep -Eq '^-----BEGIN (RSA |EC |)PRIVATE KEY-----$' "${staged_private_key}" \
  || fail 'private key source is not a supported PEM private key'

openssl x509 -in "${staged_certificate}" -noout >/dev/null 2>&1 \
  || fail 'server certificate cannot be parsed'
openssl pkey -in "${staged_private_key}" -noout -check >/dev/null 2>&1 \
  || fail 'private key cannot be parsed or validated'
openssl x509 -in "${staged_certificate}" -noout -checkend 86400 >/dev/null 2>&1 \
  || fail 'server certificate is expired or expires within 24 hours'
openssl x509 -in "${staged_certificate}" -noout -checkhost "${domain}" >/dev/null 2>&1 \
  || fail 'server certificate does not cover firesidechat.cn'
openssl verify -CAfile "${trust_store}" -untrusted "${staged_certificate}" -purpose sslserver "${staged_certificate}" >/dev/null 2>&1 \
  || fail 'server certificate chain is not trusted by the system CA store'

openssl x509 -in "${staged_certificate}" -pubkey -noout >"${work}/certificate.pub"
openssl pkey -in "${staged_private_key}" -pubout >"${work}/private-key.pub" 2>/dev/null
cmp -s "${work}/certificate.pub" "${work}/private-key.pub" \
  || fail 'server certificate and private key do not match'

readonly rendered_config=${work}/nginx.conf
sed \
  -e "s#ssl_certificate /run/credentials/fireside-https.service/fullchain.pem;#ssl_certificate ${staged_certificate};#" \
  -e "s#ssl_certificate_key /run/credentials/fireside-https.service/privkey.pem;#ssl_certificate_key ${staged_private_key};#" \
  -e "s#pid /run/fireside-https/nginx.pid;#pid ${work}/nginx.pid;#" \
  -- "${nginx_config}" >"${rendered_config}"
chmod 0600 "${rendered_config}"
grep -q 'server_name firesidechat.cn www.firesidechat.cn;' "${rendered_config}" \
  || fail 'Fireside Nginx configuration targets a different domain'
/usr/sbin/nginx -t -q -c "${rendered_config}" \
  || fail 'Fireside Nginx configuration rejected the staged TLS materials'

had_certificate=false
had_private_key=false
was_active=false
[[ -e ${live_dir}/fullchain.pem ]] && had_certificate=true
[[ -e ${live_dir}/privkey.pem ]] && had_private_key=true
systemctl is-active --quiet "${unit}" && was_active=true
if [[ ${had_certificate} == true ]]; then
  [[ -f ${live_dir}/fullchain.pem && ! -L ${live_dir}/fullchain.pem \
    && $(stat -c '%u:%g:%a:%h' -- "${live_dir}/fullchain.pem") == 0:0:644:1 ]] \
    || fail 'existing certificate metadata is unsafe'
  install -o root -g root -m 0600 -- "${live_dir}/fullchain.pem" "${work}/previous-fullchain.pem"
fi
if [[ ${had_private_key} == true ]]; then
  [[ -f ${live_dir}/privkey.pem && ! -L ${live_dir}/privkey.pem \
    && $(stat -c '%u:%g:%a:%h' -- "${live_dir}/privkey.pem") == 0:0:600:1 ]] \
    || fail 'existing private key metadata is unsafe'
  install -o root -g root -m 0600 -- "${live_dir}/privkey.pem" "${work}/previous-privkey.pem"
fi

rollback() {
  if [[ ${had_certificate} == true ]]; then
    install -o root -g root -m 0644 -- "${work}/previous-fullchain.pem" "${live_dir}/.fullchain.rollback"
    mv -fT -- "${live_dir}/.fullchain.rollback" "${live_dir}/fullchain.pem"
  else
    rm -f -- "${live_dir}/fullchain.pem"
  fi
  if [[ ${had_private_key} == true ]]; then
    install -o root -g root -m 0600 -- "${work}/previous-privkey.pem" "${live_dir}/.privkey.rollback"
    mv -fT -- "${live_dir}/.privkey.rollback" "${live_dir}/privkey.pem"
  else
    rm -f -- "${live_dir}/privkey.pem"
  fi
  sync -f "${live_dir}"
  if [[ ${was_active} == true ]]; then
    systemctl restart "${unit}" >/dev/null 2>&1 || true
  else
    systemctl stop "${unit}" >/dev/null 2>&1 || true
  fi
}

install -o root -g root -m 0644 -- "${staged_certificate}" "${live_dir}/.fullchain.new"
install -o root -g root -m 0600 -- "${staged_private_key}" "${live_dir}/.privkey.new"
sync -f "${live_dir}/.fullchain.new"
sync -f "${live_dir}/.privkey.new"
mv -fT -- "${live_dir}/.fullchain.new" "${live_dir}/fullchain.pem"
mv -fT -- "${live_dir}/.privkey.new" "${live_dir}/privkey.pem"
sync -f "${live_dir}"

if ! systemctl restart "${unit}" >/dev/null 2>&1; then
  rollback
  fail 'HTTPS service rejected the new TLS materials; previous materials restored'
fi
healthy=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --fail --silent --max-time 3 \
    --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 0.5
done
if [[ ${healthy} != true ]]; then
  rollback
  fail 'local HTTPS health check failed; previous materials restored'
fi

expires=$(openssl x509 -in "${live_dir}/fullchain.pem" -noout -enddate | cut -d= -f2-)
echo "Fireside TLS materials installed for ${domain}; expires ${expires}"
