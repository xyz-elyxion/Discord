const Config = {
    "token": process.env.LIMEBOT_TOKEN || "",
    // commands are slash-only; prefixes were removed
    // id of the home guild of the bot. used for registering commands, etc
    "homeGuildId": "1550709562267672607",
    // "development" | "production"
    "mode": "development",

    // base URL of the limey web server (used to update the public status endpoint)
    "limeyApiBase": process.env.LIMEY_API_BASE || "http://127.0.0.1:" + (process.env.PORT || 3000),

    "channels": {
        // channel where limebot will post automatic moderation logs, leave empty to disable
        "autoModLog": "1554326022252535918",

        // channel where limebot will post moderation logs (like ban, mute, etc), leave empty to disable
        "modLog": "1554326022252535918",

        // channel where limebot will post bot audit logs (badge changes, etc), leave empty to disable
        "botAuditLog": "1450180761679302676",

        // channel where limebot will send information like errors
        "dev": "1033680203433660458",

        // used as default for the not-support command and some other features
        "support": "1553920145804628058",

        // channels where support commands are allowed.
        // always includes channels.dev and channels.support
        "supportAllowedChannels": [
            "1345457031426871417", // vesktop support
            "1024286218801926184", // bot spam
        ],
    },

    "tickets": {
        // role pinged when a new support ticket is opened; can close tickets
        "helper": "1244313853357981787",
        // can also close tickets
        "mod": "1026509424686284924",
    },

    "roles": {
        // staff hierarchy (new Limey V1 server roles)
        "owner": "1552126541607993354",
        "developer": "1551886339203534865",
        // given to users who contributed and joined the server
        "contributor": "1554395361114718218",
        "headAdministrator": "1554394487353114624",
        "administrator": "1554394441786331146",
        "trialAdministrator": "1554394541564366858",
        "headModerator": "1554394646891855982",
        "moderator": "1554394807961387060",
        "trialModerator": "1554394923057287208",

        // anyone with any of these roles can execute moderation commands
        "staffRoles": [
            "1552126541607993354", // owner
            "1551886339203534865", // developer
            "1554394487353114624", // head administrator
            "1554394441786331146", // administrator
            "1554394541564366858", // trial administrator
            "1554394646891855982", // head moderator
            "1554394807961387060", // moderator
            "1554394923057287208", // trial moderator
        ],

        // legacy roles (kept for reference/backwards compatibility)
        "mod": "1026509424686284924",
        // anyone with this role has limited access to moderation commands like mute
        "helper": "1244313853357981787",
        // used for github linking and some other things
        "donor": "1042507929485586532",
        // used for regular cotd
        "regular": "1026504932959977532",

        // roles that can be added or removed using the role management commands.
        // always includes roles.donor, roles.regular, and roles.contributor
        "manageableRoles": [
            "1191202487978438656", // programming
            "1136687385434918992", // image sender
            "1018310742874791977", // brain rot
            "1118620309382254654", // can't talk
            "1173623814211506207", // can't vc
            "1161815552919076867", // no modmail
            "1088566810976194693", // needy
            "1061276426478813245", // no support
            "1205614728148422716", // no programming
            "1427368278866792669", // no ai
            "1241355250129178775", // angelsachse (no german)
            "1136184488498561035", // snippet dev
        ]
    },

    "moderation": {
        // guilds members may share invites to. always includes homeGuildId
        "inviteAllowedGuilds": [
            "1015060230222131221", // Limey V1
            "811255666990907402", // aliucord
            "1015931589865246730", // vendetta
            "86004744966914048", // betterdiscord
            "538759280057122817", // powercord
            "950850315601711176", // enmity
            "920674107111137340", // stupidity archive
            "820732039253852171", // armcord
            "458997239738793984", // strencher
            "917308687423533086", // manti (reviewdb)
            "613425648685547541", // ddevs
            "891039687785996328", // kernel
            "244230771232079873", // progamers hangout
            "1096357702931841148", // decor
            "449175561529589761", // blackbox (userbg)
            "1196075698301968455", // pyoncord
            "1154257010532032512", // moonlight
            "961691461554950145", // hyprland
            "1097993424931672216", // aero
            "1116074561734197270", // dziurwa insane
            "820745488231301210", // ntts
            "603970300668805120", // discord previews
            "1368145952266911755", // kettu / rain
        ]
    },

    "xp": {
        "eligibleCategories": [
            "1015060231060983889", // chat
            "1216095839848501338", // limey-discord.onrender.comelopment
            "1553922850669334600" // support
        ],
        "rewards": {
            5: "1136687385434918992", // image sender
        }
    },

    // rule command
    "rules": {
        "enabled": true,
        "rulesChannelId": "1015074670963335219"
    },

    // known issue command
    "knownIssues": {
        "enabled": true,
        "knownIssuesForumId": "1257025907625951423"
    },

    // submission pass command
    "submissionPass": {
        "enabled": true,
        "categoryId": "1216095763571019887",
        "passRoleId": "1257065526019231945"
    },

    // gemini ai command
    "gemini": {
        "enabled": false,
        "apiKey": "",
        "allowedRoles": [
            "1026509424686284924", // mod
            "1042507929485586532", // donor
            "1026534353167208489", // contributor
            "1026504932959977532", // regular
        ],
        "bannedRoles": [
            "1427368278866792669", // no ai
            "1018310742874791977" // brain rot
        ],
    },

    // vfable command. Uses gemini's allowedRoles and bannedRoles. Leave apiKey empty to disable.
    "anthropic": {
        "apiKey": "", // Anthropic Platform API key
    },

    // Wolfram Alpha command. Leave appId empty to disable.
    "wolfram": {
        "appId": "", // Short Answers API
    },

    "modmail": {
        "enabled": true,
        // category/channel where modmail threads are created
        "channelId": "1553920145804628058",
        // modmail logs go to the shared mod-log channel (channels.modLog) like other moderation actions
        "logChannelId": "",
        // role that will be mentioned (without ping) in new tickets to pull everyone into the thread
        "modRoleId": "1554394807961387060",
        // role that will be given to ban users from opening tickets
        "banRoleId": "1161815552919076867"
    },

    // http server used for some features.
    // github linking and reporter both depend on this server
    "httpServer": {
        "enabled": true,
        "port": 8152,
        "domain": "http://localhost:8152"
    },

    // link-github command which gives out contributor & donor roles
    "githubLinking": {
        "enabled": false,
        "clientId": "",
        "clientSecret": "",
        // Github Personal Access Token. Used to check if user is sponsoring you https://github.com/settings/tokens/new
        "pat": ""
    },

    // Advent of Code private leaderboard tracker
    "adventOfCode": {
        "enabled": false,
        // logged in browser cookie
        "cookie": "",
        // channel to post the leaderboard in
        "channelId": "1312179898550456350",
        // link to the leaderboard to use
        "leaderboardUrl": "https://adventofcode.com/2024/leaderboard/private/view/1776680",
    },

    "reporter": {
        "enabled": false,
        // Github PAT with workflow dispatch scope. Used to trigger reporter workflow
        "pat": "",
        // generate with `openssl rand -hex 128`
        "webhookSecret": "",
        // channel where each individual report will be posted
        "logChannelId": "1337479880849362994",
        // channel where the bot will post the latest status of stable and canary
        "statusChannelId": "1337479816240431115",
        // message id of the stable status message (must be in statusChannelId)
        "stableMessageId": "1337500395311992954",
        // message id of the canary status message (must be in statusChannelId)
        "canaryMessageId": "1337500381923774544",
    },

    // Google private APIs seem to throttle non-residential IPs.
    // If you're experiencing this issue, set up a Cloudflare Worker with the code in assets/googleProxyWorker.js
    // and fill in the url and secret here.
    "googleProxy": {
        "url": "https://example.workers.dev",
        "secret": "",
    }
};

export default Config;
