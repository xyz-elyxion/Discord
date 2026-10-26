# Contributing to Limey V1

Limey V1 is a community project and welcomes any kind of contribution from anyone!

We have development documentation for new contributors, which can be found at <https://limey-discord.onrender.com/docs>.

## How to contribute

Contributions can be sent via pull requests.

Pull requests can be made to the `main` branch.

Before working on a major change, I highly recommend opening a feature request for it, making sure to check "I am willing to work on this myself",
so we can discuss before you invest time. Alternatively, you can also do so in our Discord server's development
channels. This saves you a lot of time in case your feature is considered too niche or rejected for any other reason.

## Write a plugin

Writing a plugin is the primary way to contribute.

Before starting your plugin:
- Consider if this plugin would be useful to a large portion of the userbase. We do not accept niche plugins
- Check existing pull requests to see if someone is already working on a similar plugin
- Familarise yourself with our plugin rules below to ensure your plugin is not banned

### Plugin Rules

- No simple slash command plugins like `/cat`. Instead, make a [user installable Discord bot](https://discord.com/developers/docs/change-log#userinstallable-apps-preview)
- No simple text replace plugins like Let me Google that for you. The TextReplace plugin can do this
- No raw DOM manipulation. Use proper patches and React
- No plugins that simply hide or redesign ui elements. This can be done with CSS
- No plugins that interact with specific Discord bots (official Discord apps like Youtube WatchTogether are okay)
- No untrusted third party APIs. Popular services like Google or GitHub are fine, but absolutely no self hosted ones
- Do not introduce new dependencies unless absolutely necessary and warranted

## Improve Limey V1 itself

If you have any ideas on how to improve Limey V1 itself, or want to propose a new plugin API, feel free to open a feature request so we can discuss.

Or if you notice any bugs or typos, feel free to fix them!

## Help out users in our Discord community

We have an open support channel in our [Discord community](n8rmQJRAzV).
Helping out users there is always appreciated! The more, the merrier.
