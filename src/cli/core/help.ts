export const HELP = `
Cognautic Forge (Node CLI)

Interactive Mode:
  forge
  # opens interactive chat with / commands and tab suggestions
  forge resume <chat-id|name>
  # resume an existing chat by id or renamed chat name

Slash Commands in Chat:
  /help
  /exit
  /status
  /providers
  /provider <provider>
  /models [refresh]
  /model <model-id>
  /apikey <key>
  /apikey <provider> <key>
  /endpoint <url>
  /searchmode <safe|manual>
  /mode <safe|yolo>
  /yolo [on|off|toggle]
  /root <path>
  /objective <text> | /objective show
  /task <add|list|approve|start|review|complete|archive> ...
  /artifact <add|list> ...
  /timeline
  /roles [show] | /roles set <role> <owner>
  /rename <chat-name>

CLI Commands:
  forge --reset
  forge reset
  forge state show
  forge state set-root <path>
  forge state set-browser </usr/sbin/brave>
  forge provider show
  forge provider set <provider> <model> [--endpoint URL]
  forge provider key set <provider> <api-key>
  forge provider models [provider]
  forge chat <prompt>
  forge workspace show
  forge workspace objective <text>
  forge workspace task <add|list|set> ...

Browser launch override:
  forge browser launch --executable /usr/sbin/brave
`;
