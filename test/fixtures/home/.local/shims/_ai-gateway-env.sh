# Shared by the opencode/claude shims. Source, don't exec.
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  _gw_service='Vercel AI Gateway'
  case "$PWD/" in
    "$HOME/Code/acme/"*) _gw_service='Vercel AI Gateway Work' ;;
  esac
  _gw_key="$(/usr/bin/security find-generic-password -s "$_gw_service" -a 'vercel-ai-gateway' -w 2>/dev/null || true)"
  [ -n "$_gw_key" ] && export AI_GATEWAY_API_KEY="$_gw_key"
  unset _gw_service _gw_key
fi
