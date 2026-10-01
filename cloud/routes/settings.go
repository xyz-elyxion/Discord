package routes

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"

	g "limeycloud/backend/globals"
	"limeycloud/backend/kv"
	"limeycloud/backend/util"
)

// /v1/settings

func HEADSettings(c *fiber.Ctx) error {
	userId := c.Context().UserValue("userId").(string)

	written, err := kv.HGet("settings:"+util.Hash(g.PEPPER_SETTINGS+userId), "written")

	if err == kv.ErrNotFound {
		return c.Status(404).Send(nil)
	} else if err != nil {
		panic(err)
	}

	c.Set("ETag", written)
	return c.SendStatus(204)
}

func GETSettings(c *fiber.Ctx) error {
	userId := c.Context().UserValue("userId").(string)

	settings, err := kv.HMGet("settings:"+util.Hash(g.PEPPER_SETTINGS+userId), "value", "written")

	if err != nil {
		panic(err)
	}

	if settings[0] == nil {
		return c.Status(404).Send(nil)
	}

	// value is compressed data, written is a timestamp
	value, written := []byte(settings[0].(string)), settings[1].(string)

	if ifm := c.Get("if-none-match"); ifm == written {
		return c.SendStatus(304)
	}

	c.Set("Content-Type", "application/octet-stream")
	c.Set("ETag", written)
	return c.Send(value)
}

func PUTSettings(c *fiber.Ctx) error {
	if c.Get("Content-Type") != "application/octet-stream" {
		return c.Status(415).JSON(&fiber.Map{
			"error": "Content type must be application/octet-stream",
		})
	}

	if len(c.Body()) > g.SIZE_LIMIT {
		return c.Status(413).JSON(&fiber.Map{
			"error": "Settings are too large",
		})
	}

	userId := c.Context().UserValue("userId").(string)

	now := time.Now().UnixMilli()

	err := kv.HSet("settings:"+util.Hash(g.PEPPER_SETTINGS+userId), map[string]any{
		// value is raw deflate bytes (base64-wrapped by the Postgres kv layer);
		// written must be a string to mirror the redis-era HMGet semantics
		"value":   string(c.Body()),
		"written": fmt.Sprintf("%d", now),
	})

	if err != nil {
		panic(err)
	}

	return c.JSON(&fiber.Map{
		"written": now,
	})
}

func DELETESettings(c *fiber.Ctx) error {
	userId := c.Context().UserValue("userId").(string)

	_ = kv.Del("settings:" + util.Hash(g.PEPPER_SETTINGS + userId))

	return c.SendStatus(204)
}
