---
title: Installing custom plugins
description: How to install custom plugins in Limey V1
---

:::danger

These instructions are provided for **advanced users**.

If you don't understand these instructions, you should not attempt to install custom plugins.

We do not provide support with custom plugins / installs, and you are responsible for any issues that may arise from using them.

If you run into issues and can't figure them out yourself, please stick to the [official Limey V1 build](https://limey-discord.onrender.com/download).
:::

## Prerequisite

To add custom plugins, you need to build Limey V1 from source.

If you haven't already done so, first follow the [Installing from Source](/installing) guide. 

The following instructions assume you have already done so.

## Adding plugins

Open your Limey V1 folder. Inside it, you should find a folder called `src`. This folder houses all of Limey V1's source code.

If you don't have this folder, you have not read the previous instructions. Go back and first follow the [Installing from Source](/installing) guide.

### Creating the `userplugins` folder

All official plugins are stored in the `src/plugins` folder.
However, unless you plan to [submit your plugin to the official repository](/plugins/submission), you should not put your plugin there, as you will run into conflicts.

Instead, you will want to use the `src/userplugins` folder. This folder is reserved for custom / private plugins.

This folder won't exist yet, so you'll have to first create it. Navigate to the `src` folder and create a new folder called `userplugins`.

### Adding your plugin

Inside the `userplugins` folder, you can now add your plugin.

Your plugin should be either a simple `myCoolPlugin.ts` or `myCoolPlugin.tsx` file, or a folder containing an `index.ts` or `index.tsx` file.

Place it inside the previously created userplugins folder.

:::tip[Good]
- `src/userplugins/myCoolPlugin.ts`
- `src/userplugins/myCoolPlugin/index.tsx`
:::

:::danger[Bad]
- `src/userplugins/myCoolPlugin/myCoolPlugin.ts`
- `src/userplugins/coolPlugins/myCoolPlugin/index.tsx`
:::

### Building Limey V1

The last step is [rebuilding Limey V1](/installing#building-limey-v1).

Restart Discord and your plugin should show up in the plugins tab!

:::caution
Be careful not to accidentally create an empty folder or an empty plugin file inside your `userplugins` folder.

If you get a `TypeError: Cannot read properties of undefined (reading 'localeCompare')` error, this is why.
:::
