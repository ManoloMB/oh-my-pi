{{#if isSet}}Instructions from: {{path}}

Applies to work under `{{scope}}`. More specific instructions take precedence over broader ones; they do not override system, developer, or direct user instructions.

{{content}}{{/if}}{{#if isUpdated}}Updated instructions from: {{path}}

This file changed since it was shown earlier. Use the content below instead.

{{content}}{{/if}}{{#if isRemoved}}Instructions removed: {{path}}

The previously loaded instructions from this file no longer apply.{{/if}}
