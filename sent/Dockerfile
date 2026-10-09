# Limey Guard — server image
# Build:  docker build -t limey-guard .
# Run:    docker run --env-file .env -p 8080:8080 limey-guard

FROM golang:1.22-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/server ./cmd/server && go build -o /out/migrate ./cmd/migrate

FROM alpine:3.20
# dashboards + ca for https probes
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 sentinel
COPY --from=build /out/server /usr/local/bin/server
COPY --from=build /out/migrate /usr/local/bin/migrate
USER sentinel
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/server"]
