default:
    @just --list

fmt:
    vp fmt .

lint:
    vp run lint

tc:
    vp run tc

test:
    vp run test

build:
    vp run build

check:
    vp fmt --check
    vp run lint
    vp run tc
    vp run test
    vp run build
    test -f dist/driver.mjs
    test -s dist/driver.mjs
    test -x dist/driver.mjs
    test "$(head -n 1 dist/driver.mjs)" = '#!/usr/bin/env bun'

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
