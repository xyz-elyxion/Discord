/*
 * Limey V1 — InteractiveVerification plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";

export const CHANGELOG = [
    {
        version: "1.1.0",
        date: "2026-10-06",
        entries: [
            "Toolbox entry is now hidden when verification isn't set up on any of your servers.",
            "Added this changelog."
        ]
    },
    {
        version: "1.0.0",
        date: "2026-09-20",
        entries: [
            "Initial release: verify into servers right from your client via Discord's OAuth modal."
        ]
    }
] as const;

export function VerificationChangelog() {
    return (
        <>
            {CHANGELOG.map(({ version, date, entries }) => (
                <div key={version} style={{ marginBottom: 12 }}>
                    <Paragraph style={{ fontWeight: 600 }}>
                        v{version} <span style={{ opacity: 0.6, fontWeight: 400 }}>— {date}</span>
                    </Paragraph>
                    <ul style={{ margin: "4px 0 0 18px", listStyle: "disc" }}>
                        {entries.map(e => (
                            <li key={e}><Paragraph>{e}</Paragraph></li>
                        ))}
                    </ul>
                </div>
            ))}
        </>
    );
}
