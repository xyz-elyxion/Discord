/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2024 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

export { gitHash, gitRemote };

export const LIMEYV1_USER_AGENT = `Limey V1/${gitHash}${gitRemote ? ` (https://github.com/${gitRemote})` : ""}`;
