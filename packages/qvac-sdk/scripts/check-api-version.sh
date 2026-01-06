#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a file is in the list of API files
is_api_file() {
    local file="$1"
    
    # Check if file is in client directory or is the top-level index.ts
    if [[ "$file" == "index.ts" ]] || [[ "$file" == "client/"* && "$file" == *.ts ]]; then
        # Exclude test files and internal implementation details
        if [[ "$file" != *test* ]] && [[ "$file" != *spec* ]]; then
            return 0
        fi
    fi
    
    return 1
}

# Function to compare semantic versions
# Returns 0 if version1 > version2, 1 otherwise
version_gt() {
    local version1="$1"
    local version2="$2"
    
    # Remove 'v' prefix if present
    version1="${version1#v}"
    version2="${version2#v}"
    
    # Split versions into components
    IFS='.' read -r -a v1_parts <<< "$version1"
    IFS='.' read -r -a v2_parts <<< "$version2"
    
    # Compare major version
    if [ "${v1_parts[0]}" -gt "${v2_parts[0]}" ]; then
        return 0
    elif [ "${v1_parts[0]}" -lt "${v2_parts[0]}" ]; then
        return 1
    fi
    
    # Major versions are equal, compare minor
    if [ "${v1_parts[1]:-0}" -gt "${v2_parts[1]:-0}" ]; then
        return 0
    elif [ "${v1_parts[1]:-0}" -lt "${v2_parts[1]:-0}" ]; then
        return 1
    fi
    
    # Major and minor are equal, compare patch
    if [ "${v1_parts[2]:-0}" -gt "${v2_parts[2]:-0}" ]; then
        return 0
    fi
    
    return 1
}

# Function to check if major version was bumped
major_version_bumped() {
    local old_version="$1"
    local new_version="$2"
    
    # Remove 'v' prefix if present
    old_version="${old_version#v}"
    new_version="${new_version#v}"
    
    # Extract major versions
    old_major="${old_version%%.*}"
    new_major="${new_version%%.*}"
    
    if [ "$new_major" -gt "$old_major" ]; then
        return 0
    fi
    
    return 1
}

# Get the list of staged files
staged_files=$(git diff --cached --name-only)

# Check if any API files are being modified
api_files_changed=false
changed_api_files=()

for file in $staged_files; do
    if is_api_file "$file"; then
        api_files_changed=true
        changed_api_files+=("$file")
    fi
done

# If no API files changed, allow the commit
if [ "$api_files_changed" = false ]; then
    exit 0
fi

echo -e "${YELLOW}🔍 API files changed:${NC}"
for file in "${changed_api_files[@]}"; do
    echo "  - $file"
done
echo ""

# Check if package.json is staged
if ! git diff --cached --name-only | grep -q "^package.json$"; then
    echo -e "${RED}❌ ERROR: API files have been modified but package.json is not staged.${NC}"
    echo -e "${RED}When changing API files, you must update the version in package.json.${NC}"
    echo ""
    echo "To fix this:"
    echo "  1. Update the version in package.json (bump major version)"
    echo "  2. Stage package.json: git add package.json"
    echo "  3. Retry your commit"
    exit 1
fi

# Get the old and new versions from package.json
old_version=$(git show HEAD:package.json 2>/dev/null | grep '"version"' | sed -E 's/.*"version": *"([^"]+)".*/\1/')
new_version=$(git show :package.json | grep '"version"' | sed -E 's/.*"version": *"([^"]+)".*/\1/')

# If we couldn't get the old version (new repo), allow the commit
if [ -z "$old_version" ]; then
    echo -e "${GREEN}✅ Initial commit detected, skipping version check.${NC}"
    exit 0
fi

echo "📦 Version check:"
echo "  Old version: $old_version"
echo "  New version: $new_version"
echo ""

# Check if version was changed
if [ "$old_version" = "$new_version" ]; then
    echo -e "${RED}❌ ERROR: API files have been modified but version in package.json has not been changed.${NC}"
    echo -e "${RED}You must bump the major version when changing API files.${NC}"
    echo ""
    echo "Current version: $old_version"
    echo "Please update the version in package.json and stage the changes."
    exit 1
fi

# Check if version was bumped (not just changed)
if ! version_gt "$new_version" "$old_version"; then
    echo -e "${RED}❌ ERROR: New version ($new_version) must be greater than old version ($old_version).${NC}"
    exit 1
fi

# Check if major version was bumped
if ! major_version_bumped "$old_version" "$new_version"; then
    echo -e "${RED}❌ ERROR: API files have been modified. You must bump the MAJOR version.${NC}"
    echo -e "${RED}Current: $old_version -> $new_version (only minor/patch bump)${NC}"
    echo ""
    echo "Since you've made breaking changes to the API, you need to bump the major version."
    
    # Calculate next major version
    next_major=$((${old_version%%.*} + 1))
    echo "For example: $old_version -> ${next_major}.0.0"
    exit 1
fi

echo -e "${GREEN}✅ Version check passed! Major version bumped from $old_version to $new_version${NC}"
exit 0
