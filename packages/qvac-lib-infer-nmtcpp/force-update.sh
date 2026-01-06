#!/bin/bash

git reset --hard HEAD~1 && git pull && rm -rf prebuilds && bare-dev install && bare test/addon.test.js
