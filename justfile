default:
    @just --list

fmt:
    vp fmt .

lint: fmt
    vp run lint

tc: lint
    vp run tc

test: lint
    vp run test

build: test
    vp run build

check:
    vp run lint
    vp run tc
    vp run test
    vp run build
    test -f dist/driver.mjs

image-build:
    vp run image:build

live-anthropic:
    vp run test:live:anthropic

live-openai:
    vp run test:live:openai

live-opencode:
    vp run test:live:opencode

clean:
    fd -u -t d -F node_modules . -X rm -rf
    fd -u -t d -F dist . -X rm -rf
