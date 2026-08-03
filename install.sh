#!/usr/bin/env bash
# Installs the project-update-auto-poster into a target git repo (VENDORED
# model). The referenced composite action is usually preferable — a thin caller
# workflow that `uses: e4-explore/e4-efficiency/actions/auto-post@v1`, so fixes
# propagate without re-running this script. See docs/setup.md §1A. Use this
# vendored install when you want everything in-repo with no external action.
# Usage: ./install.sh <path-to-target-repo>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <path-to-target-repo>" >&2
  exit 1
fi

TARGET="$1"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$TARGET/.git" ]; then
  echo "Error: $TARGET is not a git repository." >&2
  exit 1
fi

WORKFLOW_DIR="$TARGET/.github/workflows"
SCRIPT_DIR="$TARGET/.github/auto-post"

mkdir -p "$WORKFLOW_DIR" "$SCRIPT_DIR"

cp "$SKILL_DIR/templates/auto-post.yml"       "$WORKFLOW_DIR/auto-post.yml"
cp "$SKILL_DIR/templates/post.mjs"            "$SCRIPT_DIR/post.mjs"
cp "$SKILL_DIR/templates/package.json"        "$SCRIPT_DIR/package.json"
cp "$SKILL_DIR/templates/config.example.json" "$SCRIPT_DIR/config.example.json"

# Bundle the FREE post-scorer core (@e4/post-scorer) so vendored installs get
# the pre-post score + weak-spot diagnosis. It's zero-dependency pure ESM;
# post.mjs loads it from ./scorer/. The PAID optimizer (@e4/post-scorer-pro) is
# NOT bundled — subscribers drop it into .github/auto-post/scorer-pro/ and set
# POST_SCORER_LICENSE_KEY to unlock auto-optimize. (Referenced-mode installs get
# both from the tagged repo and skip this copy entirely.)
rm -rf "$SCRIPT_DIR/scorer"
mkdir -p "$SCRIPT_DIR/scorer"
cp -R "$SKILL_DIR/packages/scorer/src"          "$SCRIPT_DIR/scorer/src"
cp    "$SKILL_DIR/packages/scorer/package.json" "$SCRIPT_DIR/scorer/package.json"

cat <<EOF

Installed into $TARGET:
  .github/workflows/auto-post.yml
  .github/auto-post/post.mjs
  .github/auto-post/package.json
  .github/auto-post/config.example.json

Next steps:
  1. In the target repo on GitHub, Settings → Secrets and variables → Actions → New repository secret. Add:
       GEMINI_API_KEY            (https://aistudio.google.com/apikey)
       X_API_KEY                 (X developer portal → your app → Keys and tokens → Consumer Keys)
       X_API_SECRET
       X_ACCESS_TOKEN            (same screen → Authentication Tokens; permissions must be Read+Write)
       X_ACCESS_TOKEN_SECRET

  2. Pick an image source (first match wins):
       a. Commit a 1280×800 PNG at .github/auto-post/cover.png — used verbatim.
       b. Rename config.example.json to config.json and set the preview
          build/serve command — CI builds the pushed code and screenshots it
          (no deployed URL needed; Gemini picks the best route by looking
          at the actual screenshots).
       c. Settings → top of General → Website: set the deployed URL to
          screenshot.

  3. (Optional) Deploy-gate + commit-link via repo variables (Settings →
     Secrets and variables → Actions → Variables):
       DEPLOY_GATE_HEALTH_URL   a health endpoint returning the deployed SHA
       INCLUDE_COMMIT_LINK      set to "true" to append the commit URL

  4. Commit and push the new files. The next merge to main triggers the first post.
     To post about merges that already landed: Actions tab → Auto-post project
     update → Run workflow → paste the commit SHA.

EOF
