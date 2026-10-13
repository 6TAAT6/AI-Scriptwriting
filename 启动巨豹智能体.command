#!/bin/zsh
cd -- "${0:A:h}"
exec node apps/drama-studio/scripts/start.mjs
