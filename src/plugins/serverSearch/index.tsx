/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, Tooltip } from "@webpack/common";

function SearchIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" id="lime-searchbutton-icon">
            <path
                fill="currentColor"
                fillRule="evenodd"
                d="M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.421.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"
                clipRule="evenodd"></path>
        </svg>
    );
}

export default definePlugin({
    name: "ServerSearch",
    authors: [Devs.camila314],
    description: "Navigate your servers better with a quick search button",
    tags: ["Shortcuts", "Servers"],

    renderButton() {
        return <ErrorBoundary noop>
            <div id="lime-searchbutton-container">
                <Tooltip text="Search" position="right">
                    {({ onMouseEnter, onMouseLeave }) => (
                        <div
                            id="lime-searchbutton"
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            onClick={() =>
                                FluxDispatcher.dispatch({
                                    type: "QUICKSWITCHER_SHOW",
                                    query: "",
                                    queryMode: null
                                })
                            }>
                            <SearchIcon />
                        </div>
                    )}
                </Tooltip>
            </div>
        </ErrorBoundary>;
    },

    start() {
        addServerListElement(ServerListRenderPosition.Above, this.renderButton);
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderButton);
    }
});
