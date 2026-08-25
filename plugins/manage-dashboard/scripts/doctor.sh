#!/usr/bin/env bash
# Read-only health report for a Claude Dashboard install. Changes nothing.
#
# Answers, in order, the questions that actually explain a misbehaving dashboard:
# is the server up, is launchd running it, WHICH checkout is it running (the
# commonest surprise — you edited your dev tree and the agent runs the deployed
# one), is that checkout current, are the watchers healthy, and what has the log
# complained about lately.
#
# Usage: doctor.sh [--log-lines N]
set -uo pipefail

PORT="${PORT:-7777}"
LABEL=com.claude-dashboard
DATA="$HOME/.claude-dashboard"
LOG="$HOME/Library/Logs/claude-dashboard.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_LINES=15
[ "${1:-}" = "--log-lines" ] && LOG_LINES="${2:-15}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "Server (port $PORT)"
if body=$(curl -fsS --max-time 5 "http://localhost:$PORT/api/sessions" 2>/dev/null); then
  n=$(printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("sessions",d) if isinstance(d,dict) else d))' 2>/dev/null || echo '?')
  ok "responding — $n live session(s)"
else
  bad "not responding on http://localhost:$PORT"
  info "start it: ./scripts/start.sh   (or: node server/src/index.js)"
fi

head_ "launchd agent ($LABEL)"
if [ -f "$PLIST" ]; then
  running=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null) || running=""
  if [ -n "$running" ]; then
    st=$(printf '%s' "$running" | awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}')
    pid=$(printf '%s' "$running" | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}')
    ok "loaded — state=${st:-?} pid=${pid:-none}"
    last=$(printf '%s' "$running" | awk -F'= ' '/last exit code = /{print $2; exit}')
    case "${last:-0}" in
      ''|0|*[!0-9]*) ;;                      # absent, clean, or "(never exited)"
      *) warn "last exit code = $last" ;;
    esac
  else
    bad "plist installed but not loaded"
    info "launchctl kickstart -k gui/$(id -u)/$LABEL"
  fi
  # WHICH checkout — the answer people are usually surprised by
  app=$(python3 - "$PLIST" <<'PY' 2>/dev/null
import plistlib,sys,os
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
args=p.get('ProgramArguments') or []
entry=next((a for a in args if a.endswith('index.js')), '')
print(os.path.abspath(os.path.join(os.path.dirname(entry),'..','..')) if entry else '')
PY
)
  if [ -n "${app:-}" ]; then
    info "running from: $app"
    if [ -d "$app/.git" ]; then
      sha=$(git -C "$app" rev-parse --short HEAD 2>/dev/null)
      subj=$(git -C "$app" log -1 --pretty=%s 2>/dev/null)
      info "at $sha — $subj"
      if git -C "$app" fetch --quiet origin 2>/dev/null; then
        behind=$(git -C "$app" rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
        if [ "${behind:-0}" -gt 0 ]; then
          warn "$behind commit(s) behind origin/main — deploy: $app/scripts/deploy.sh"
        else
          ok "up to date with origin/main"
        fi
      else
        info "(could not reach origin to compare)"
      fi
      dirty=$(git -C "$app" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      [ "${dirty:-0}" -gt 0 ] && warn "deployed checkout has $dirty local change(s) — deploy.sh will discard them"
    fi
  fi
else
  warn "not installed as a service (no $PLIST)"
  info "install from the checkout you want it to run: ./scripts/install-launchd.sh"
fi

head_ "Watchers"
if wbody=$(curl -fsS --max-time 5 "http://localhost:$PORT/api/watchers" 2>/dev/null); then
  # NOTE: a heredoc IS stdin, so `printf ... | python3 - <<EOF` silently drops the
  # pipe. The payload travels by environment variable instead.
  WBODY="$wbody" python3 - <<'PY' 2>/dev/null || info "(unreadable response)"
import json,os
d=json.loads(os.environ['WBODY'])
ws=d.get('watchers', d) if isinstance(d,dict) else d
if not ws:
    print("    none configured — see watchers.example.json")
for w in ws:
    st=w.get('status') or w.get('state') or '?'
    mark={'running':'✓','offline':'!','error':'✗','paused':'!','stopped':'!'}.get(st,'·')
    color={'✓':'32','!':'33','✗':'31'}.get(mark,'0')
    bits=[]
    for k in ('type','interval','intervalSec','lastRunAt','lastError','staged'):
        if w.get(k) not in (None,''): bits.append(f"{k}={w[k]}")
    print(f"  \033[{color}m{mark}\033[0m {w.get('name','?')} — {st}")
    if bits: print("    " + " ".join(str(b) for b in bits[:4]))
PY
else
  info "(server not answering — watcher health unavailable)"
fi

head_ "Candidates"
if cbody=$(curl -fsS --max-time 5 "http://localhost:$PORT/api/candidates" 2>/dev/null); then
  CBODY="$cbody" python3 - <<'PY' 2>/dev/null || info "(unreadable response)"
import json,os
from collections import Counter
d=json.loads(os.environ['CBODY'])
c=d.get('candidates',d) if isinstance(d,dict) else d
n=Counter(x.get('status','?') for x in c)
by=Counter(x.get('source','?') for x in c)
print("    %d total — %s" % (len(c), ", ".join(f"{k}:{v}" for k,v in sorted(n.items())) or "empty"))
if by: print("    by source — %s" % ", ".join(f"{k}:{v}" for k,v in sorted(by.items())))
PY
else
  info "(server not answering)"
fi

head_ "Data dir ($DATA)"
if [ -d "$DATA" ]; then
  for f in watchers.json watchers-state.json candidates.json titles.json ai-titles.json settings.json; do
    if [ -f "$DATA/$f" ]; then
      sz=$(wc -c <"$DATA/$f" | tr -d ' ')
      info "$(printf '%-22s' "$f") ${sz}B"
    fi
  done
  [ -f "$DATA/watchers.json" ] || info "watchers.json          absent (watchers off — copy watchers.example.json)"
else
  info "absent — created on first run"
fi

head_ "Log ($LOG)"
if [ -f "$LOG" ]; then
  errs=$(grep -c ' ERROR ' "$LOG" 2>/dev/null || echo 0)
  info "$(wc -l <"$LOG" | tr -d ' ') lines, $errs ERROR"
  # Grouped, not tailed: one stuck thread retrying every poll writes thousands of
  # identical lines, and a plain tail shows only that — hiding everything else.
  LOG="$LOG" TOPN="$LOG_LINES" python3 - <<'PY' 2>/dev/null
import os,re,collections
sig=collections.Counter(); last={}
ts=re.compile(r'^\[([^\]]+)\]\s*')
with open(os.environ['LOG'], errors='replace') as f:
    for line in f:
        if ' ERROR ' not in line: continue
        when=(ts.match(line).group(1) if ts.match(line) else '')
        msg=ts.sub('', line).rstrip()
        # collapse the varying parts so one recurring fault is one row
        k=re.sub(r'\b\d{10}\.\d{6}\b','<ts>',msg)
        k=re.sub(r'\b[0-9a-f]{7,40}\b','<sha>',k)
        k=re.sub(r'\b\d+\b','<n>',k)
        sig[k]+=1; last[k]=when
if sig:
    print()
    print('  distinct errors (count · last seen):')
    for k,n in sig.most_common(int(os.environ['TOPN'])):
        print('    %6d  %s' % (n, (last[k] or '')[:19]))
        print('            %s' % k[:150])
PY
else
  info "absent (only written when running under launchd)"
fi
printf '\n'
