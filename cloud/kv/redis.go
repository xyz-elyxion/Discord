package kv

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

/**
 * Legacy Redis backend. Implements the same operations as the Postgres
 * backend so the rest of the codebase never needs to care which is active.
 */

var (
	rdb        *redis.Client
	redisNil   = redis.Nil
	ctx        = context.Background()
)

func openRedis(uri string) error {
	rdb = redis.NewClient(&redis.Options{Addr: uri})
	return rdb.Ping(ctx).Err()
}

func redisGet(key string) (string, error) {
	v, err := rdb.Get(ctx, key).Result()
	if errors.Is(err, redisNil) {
		return "", ErrNotFound
	}
	return v, err
}

func redisHGet(key, field string) (string, error) {
	v, err := rdb.HGet(ctx, key, field).Result()
	if errors.Is(err, redisNil) {
		return "", ErrNotFound
	}
	return v, err
}

func redisHMGet(key string, fields ...string) ([]any, error) {
	return rdb.HMGet(ctx, key, fields...).Result()
}

func redisHSet(key string, fields map[string]any) error {
	return rdb.HSet(ctx, key, fields).Err()
}

func redisSet(key, value string) error {
	return rdb.Set(ctx, key, value, 0).Err()
}

func redisDel(keys ...string) error {
	return rdb.Del(ctx, keys...).Err()
}

func redisScanKeys(pattern string) ([]string, error) {
	var out []string
	iter := rdb.Scan(ctx, 0, pattern, 0).Iterator()
	for iter.Next(ctx) {
		out = append(out, iter.Val())
	}
	return out, iter.Err()
}
