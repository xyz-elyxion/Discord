package routes

import (
	"github.com/gofiber/fiber/v2"

	g "limeycloud/backend/globals"
	"limeycloud/backend/kv"
	"limeycloud/backend/util"
)

// /v1

func DELETE(c *fiber.Ctx) error {
	userId := c.Context().UserValue("userId").(string)

	_ = kv.Del("settings:"+util.Hash(g.PEPPER_SETTINGS+userId))
	_ = kv.Del("secrets:"+util.Hash(g.PEPPER_SECRETS+userId))

	return c.SendStatus(204)
}

func GET(c *fiber.Ctx) error {
	return c.JSON(&fiber.Map{
		"ping": "pong",
	})
}
