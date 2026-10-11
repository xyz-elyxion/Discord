/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Card } from "@components/Card";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab } from "@components/settings/tabs/BaseTab";
import { Margins } from "@utils/margins";
import { useAwaiter } from "@utils/react";
import { getRepo, UpdateLogger, changes } from "@utils/updater";
import { React } from "@webpack/common";

import gitHash from "~git-hash";

import { HashLink } from "./../updater/Components";

function UpdateLog() {
    const [repo] = useAwaiter(getRepo, {
        fallbackValue: "https://github.com",
        onError: e => UpdateLogger.error("Failed to retrieve repo", e)
    });

    const changeList = changes?.length
        ? changes
        : [{ hash: gitHash, author: "Limey V1", message: "You are on the latest version" }];

    return (
        <>
            <HeadingSecondary className={Margins.bottom8}>Update Log</HeadingSecondary>
            <Paragraph className={Margins.bottom16}>
                Recent changes pulled into your build, newest last — this is the log of
                commits included since your previous update.
            </Paragraph>

            <Card style={{ padding: "0 0.5em" }} defaultPadding={false}>
                {changeList.map(({ hash, author, message }) => (
                    <div
                        key={hash}
                        style={{
                            marginTop: "0.5em",
                            marginBottom: "0.5em"
                        }}
                    >
                        <code>
                            <HashLink repo={repo} hash={hash} />
                        </code>

                        <span style={{
                            marginLeft: "0.5em",
                            color: "var(--text-default)"
                        }}>
                            {message} - {author}
                        </span>
                    </div>
                ))}
            </Card>
        </>
    );
}

function Changelog() {
    return (
        <SettingsTab>
            <UpdateLog />
        </SettingsTab>
    );
}

export default Changelog;
