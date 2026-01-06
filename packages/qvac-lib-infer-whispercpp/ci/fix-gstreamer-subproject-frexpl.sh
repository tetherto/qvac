#!/bin/bash

# issue reference: https://gitlab.gnome.org/GNOME/glib/-/issues/1868

set -e

sed -i '' '8i\
diff_files = 001-remove-frexp-and-frexpl-checking.patch' $GITHUB_WORKSPACE/addon/gst/gstreamer/subprojects/glib.wrap

cp $GITHUB_WORKSPACE/ci/001-remove-frexp-and-frexpl-checking.patch $GITHUB_WORKSPACE/addon/gst/gstreamer/subprojects/packagefiles

