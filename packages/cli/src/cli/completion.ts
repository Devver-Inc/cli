import { Console, Effect } from "effect";

import { listInstances } from "../../../server/identity";
import { localDeploymentIds } from "./completion-cache";

export const serverNames = Effect.tryPromise(listInstances).pipe(
  Effect.flatMap((instances) =>
    Console.log(instances.map((instance) => instance.name).join("\n"))
  ),
  Effect.ignore
);

export const deploymentIds = Effect.tryPromise(localDeploymentIds).pipe(
  Effect.flatMap((ids) => Console.log(ids.join("\n"))),
  Effect.ignore
);

const bash = `
_devver_static_completion="$(declare -f _devver)"
eval "\${_devver_static_completion/_devver ()/_devver_static ()}"
unset _devver_static_completion
_devver() {
  _devver_static "$@"
  local source=""
  if [[ $COMP_CWORD -eq 3 && \${COMP_WORDS[1]} == server && ( \${COMP_WORDS[2]} == stop || \${COMP_WORDS[2]} == remove ) ]]; then
    source=--completion-server-names
  elif [[ ( $COMP_CWORD -eq 2 || $COMP_CWORD -eq 3 ) && \${COMP_WORDS[1]} == merge ]]; then
    source=--completion-deployment-ids
  fi
  if [[ -n $source && \${COMP_WORDS[COMP_CWORD]} != -* ]]; then
    local value
    while IFS= read -r value; do
      [[ $value == "\${COMP_WORDS[COMP_CWORD]}"* ]] && COMPREPLY+=("$value")
    done < <(devver "$source")
  fi
}
complete -F _devver devver`;

const zsh = `
functions -c _devver _devver_static
_devver() {
  _devver_static "$@"
  local source=""
  if (( CURRENT == 4 )) && [[ $words[2] == server && ( $words[3] == stop || $words[3] == remove ) ]]; then
    source=--completion-server-names
  elif (( CURRENT == 3 || CURRENT == 4 )) && [[ $words[2] == merge ]]; then
    source=--completion-deployment-ids
  fi
  if [[ -n $source && $words[CURRENT] != -* ]]; then
    local -a values
    values=("\${(@f)$(devver "$source")}")
    compadd -a values
  fi
}
compdef _devver devver`;

const fish = `
function __devver_server_names
  devver --completion-server-names
end
complete -c devver -f -n '__fish_seen_subcommand_from server; and __fish_seen_subcommand_from stop remove' -a '(__devver_server_names)'
function __devver_deployment_ids
  devver --completion-deployment-ids
end
complete -c devver -f -n '__fish_seen_subcommand_from merge' -a '(__devver_deployment_ids)'`;

const completionSuffix = (shell: string) => {
  if (shell === "bash" || shell === "sh") {
    return bash;
  }
  if (shell === "zsh") {
    return zsh;
  }
  return shell === "fish" ? fish : "";
};

export const extendCompletions = (script: string, shell: string) => {
  if (shell === "zsh") {
    const entry = `if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then`;
    return script.replace(entry, `${zsh}\n${entry}`);
  }
  return `${script}\n${completionSuffix(shell)}`;
};
