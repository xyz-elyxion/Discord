CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    userId      TEXT    UNIQUE NOT NULL,
    channelId   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS expressions (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    formatType  TEXT NOT NULL CHECK(formatType IN ('png','apng','gif','lottie'))
);

CREATE TABLE IF NOT EXISTS expressionUses (
    id              TEXT    NOT NULL,
    expressionType  TEXT    NOT NULL CHECK(expressionType IN ('emoji','sticker')),
    usageType       TEXT    NOT NULL CHECK(usageType IN ('message','reaction')),
    userId          TEXT    NOT NULL,
    messageId       TEXT    NOT NULL,

    FOREIGN KEY (id) REFERENCES expressions (id)
);

CREATE INDEX IF NOT EXISTS expressionTypeIndex on expressionUses (expressionType);

CREATE TABLE IF NOT EXISTS stickyRoles (
    id      TEXT NOT NULL PRIMARY KEY,
    roleIds TEXT NOT NULL              -- Comma separated list of role IDs. Sqlite doesn't support arrays.
);

CREATE TABLE IF NOT EXISTS linkedGitHubs (
    githubId  TEXT NOT NULL PRIMARY KEY,
    discordId TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS discordIdIndex on linkedGitHubs (discordId);

CREATE TABLE IF NOT EXISTS userAvatarEmojis (
    userId      TEXT NOT NULL PRIMARY KEY,
    emojiId     TEXT NOT NULL,
    avatarHash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS xp (
    userId  TEXT PRIMARY KEY NOT NULL,
    xp      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warnings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    userId    TEXT NOT NULL,
    guildId   TEXT NOT NULL,
    moderator TEXT NOT NULL,
    reason    TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS warnings_userId_idx ON warnings (userId);

CREATE TABLE IF NOT EXISTS verificationConfigs (
    guildId TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    roleId TEXT NOT NULL,
    rulesChannelId TEXT,
    rulesText TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verificationTokens (
    token     TEXT PRIMARY KEY NOT NULL,
    guildId   TEXT NOT NULL DEFAULT '',
    userId    TEXT NOT NULL,
    used      INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS countingConfigs (
    guildId     TEXT PRIMARY KEY,
    channelId   TEXT NOT NULL,
    current     INTEGER NOT NULL DEFAULT 0,
    lastUserId  TEXT,
    best        INTEGER NOT NULL DEFAULT 0,
    recordMessageId TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    createdBy   TEXT NOT NULL,
    createdAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduledUnbans (
    userId    TEXT NOT NULL,
    guildId   TEXT NOT NULL,
    unbanAt   TEXT NOT NULL, -- ISO 8601
    reason    TEXT NOT NULL,
    moderator TEXT NOT NULL,
    PRIMARY KEY (userId, guildId)
);

CREATE TABLE IF NOT EXISTS welcomerConfigs (
    guildId   TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    message   TEXT NOT NULL,
    enabled   INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS levelingConfigs (
    guildId   TEXT PRIMARY KEY,
    announceChannelId TEXT,
    enabled   INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
);
