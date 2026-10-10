# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
#  Vortex OS — Hive Guard
#
#  Loaded as the rcfile of every Vortex terminal. It inspects each command line
#  *before* it runs and refuses well-known destructive or abusive patterns
#  (wiping the filesystem, fork bombs, reverse shells, remote-script piping,
#  crypto miners, and attempts to switch the guard off).
#
#  This is a seatbelt, not the security boundary: the real isolation comes from
#  the container (unprivileged user, dropped capabilities, read-only root,
#  pid/memory limits). See SECURITY.md.
# ─────────────────────────────────────────────────────────────────────────────

# Bee's own customisations first, so the guard is always installed last.
__HIVE_IN_RC=1
[[ -f /etc/bash.bashrc && -z ${__HIVE_SKIP_SYSTEM_RC:-} ]] && source /etc/bash.bashrc
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

# ── Look & feel ──────────────────────────────────────────────────────────────
export CLICOLOR=1
alias ls='ls --color=auto' ll='ls -alh --color=auto' grep='grep --color=auto'
PS1='\[\e[1;33m\]🐝 ${USER}\[\e[0;33m\]@vortex\[\e[0m\]:\[\e[1;36m\]\w\[\e[0m\]\$ '

if [[ -z ${__HIVE_GUARD_LOADED:-} ]]; then

# History must stay on: the guard reads the full command line from it.
HISTCONTROL=
HISTIGNORE=
HISTSIZE=5000
readonly HISTCONTROL HISTIGNORE HISTSIZE
set -o history

# rule regex (POSIX ERE)                                                                   | reason
__HIVE_RULES=(
  '(^|[;&|({[:space:]])rm[[:space:]]+([^;&|]*[[:space:]])?-[[:alnum:]-]*[rRf][^;&|]*[[:space:]](/|/\*|~/?|~/\*|\$HOME/?|\$\{HOME\}/?|/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)/?\*?)([[:space:];&|]|$)'
  '--no-preserve-root'
  ':[[:space:]]*\(\)[[:space:]]*\{'
  '\(\)[[:space:]]*\{[^}]*\|[^}]*&'
  '(^|[^[:alnum:]_])mkfs(\.[[:alnum:]]+)?([[:space:]]|$)'
  '(^|[^[:alnum:]_])(dd|shred|wipefs)[[:space:]][^;&|]*(of=)?/dev/(sd|nvme|vd|xvd|hd|mmcblk|dm-|mapper)'
  '>[[:space:]]*/dev/(sd|nvme|vd|xvd|hd|mmcblk)'
  '(^|[;&|({[:space:]])(shutdown|reboot|halt|poweroff)([[:space:];&|]|$)'
  '(^|[;&|({[:space:]])(telinit|init)[[:space:]]+[06]'
  'ch(mod|own|grp)[[:space:]]+([^;&|]*[[:space:]])?-[[:alnum:]]*R[^;&|]*[[:space:]]/([[:space:];&|]|$)'
  '(curl|wget|fetch)[^;&|]*\|[[:space:]]*(sudo[[:space:]]+)?(env[[:space:]]+)?(ba|z|da|k|fi)?sh([[:space:];&|]|$)'
  '/dev/(tcp|udp)/'
  '(^|[;&|({[:space:]])(nc|ncat|netcat)[[:space:]][^;&|]*-[[:alnum:]]*[ec]([[:space:]]|$)'
  '(xmrig|minerd|cpuminer|ethminer|nbminer|t-rex|phoenixminer|stratum\+tcp)'
  '(^|[;&|({[:space:]])(builtin[[:space:]]+|command[[:space:]]+)?(trap|enable)([[:space:];&|]|$)'
  'shopt[[:space:]][^;&|]*-u[^;&|]*extdebug'
  'set[[:space:]][^;&|]*\+(o[[:space:]]+(history|functrace|errtrace)|[[:alpha:]]*T)'
  '(^|[;&|({[:space:]])unset[[:space:]][^;&|]*(__hive|__HIVE|PROMPT_COMMAND|BASH_ENV)'
  '(^|[;&|({[:space:]])history[[:space:]]+-[[:alpha:]]*[cdr]'
  '(ba|z|da|k|fi)?sh[[:space:]][^;&|]*--(norc|noprofile|rcfile|init-file)'
  '(^|[;&|({[:space:]])env[[:space:]]+(-[[:alpha:]]*i|--ignore-environment)'
)
__HIVE_WHY=(
  'recursive delete of a system or home directory'
  'rm --no-preserve-root'
  'fork bomb'
  'fork bomb (self-replicating function)'
  'formatting a filesystem'
  'raw write to a block device'
  'raw write to a block device'
  'powering off the hive'
  'changing the system runlevel'
  'recursive permission change on /'
  'piping a downloaded script straight into a shell'
  'raw network socket (reverse shell pattern)'
  'netcat command execution (reverse shell pattern)'
  'crypto-miner'
  'tampering with shell traps or builtins'
  'switching off the Hive Guard'
  'switching off the Hive Guard'
  'switching off the Hive Guard'
  'erasing shell history (audit trail)'
  'starting an unguarded shell'
  'starting a shell with a scrubbed environment'
)
readonly -a __HIVE_RULES __HIVE_WHY

# Returns 0 when the given command line is allowed; prints the reason otherwise.
__hive_check() {
  local cmd=$1 i
  for i in "${!__HIVE_RULES[@]}"; do
    if [[ $cmd =~ ${__HIVE_RULES[$i]} ]]; then
      printf '%s' "${__HIVE_WHY[$i]}"
      return 1
    fi
  done
  return 0
}

__hive_deny() {
  # OSC 7771 is invisible to the terminal; the Vortex server uses it for the audit log.
  printf '\e]7771;hive-guard;%s\a' "$1"
  printf '\n\e[1;33m🐝 Hive Guard:\e[0m \e[31mblocked\e[0m — %s\n' "$1" >&2
  printf '\e[2m   This incident has been reported to the queen.\e[0m\n' >&2
}

__hive_hist_key=
__hive_hist_ok=1
__hive_guard() {
  local entry key line why
  # 1) Whole command line (catches pipelines like `curl … | sh`).
  entry=$(HISTTIMEFORMAT= builtin history 1)
  if [[ $entry =~ ^[[:space:]]*([0-9]+)[*]?[[:space:]]+(.*)$ ]]; then
    key=${BASH_REMATCH[1]}
    line=${BASH_REMATCH[2]}
  fi
  if [[ -n $key && $key != "$__hive_hist_key" ]]; then
    __hive_hist_key=$key
    if why=$(__hive_check "$line"); then
      __hive_hist_ok=1
    else
      __hive_hist_ok=0
      __hive_deny "$why"
      return 1
    fi
  fi
  ((__hive_hist_ok)) || return 1
  # 2) Each simple command as bash is about to run it (catches aliases and functions).
  if ! why=$(__hive_check "$BASH_COMMAND"); then
    __hive_deny "$why"
    return 1
  fi
  return 0
}
readonly -f __hive_check __hive_deny __hive_guard

__HIVE_GUARD_LOADED=1
readonly __HIVE_GUARD_LOADED
shopt -s extdebug
trap '__hive_guard' DEBUG

fi
