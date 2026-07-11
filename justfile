default:
    just --list

fmt:
    vp fmt .

lint: fmt
    bun run lint

tc: lint
    bun run tc

test: lint
    bun run test

build: test
    bun run build

ci: lint
    bun run tc
    bun run test
    bun run build

docker-build:
    bun run docker:build

live-anthropic:
    bun run test:live:anthropic

live-openai:
    bun run test:live:openai

live-opencode:
    bun run test:live:opencode

clean:
    fd -u -t d -F node_modules . -X rm -rf
    fd -u -t d -F dist . -X rm -rf
