#!/usr/bin/env python3
"""
Extract all the project's C++ source files using `compile_commands.json`.
This includes only the project's own files and ignores files added by system, dependencies, subprojects etc.
"""
import argparse
import json
import os
import re
import sys


def load_commands(path):
    with open(path, "r") as f:
        return json.load(f)


def get_project_paths(compile_commands_path):
    build_dir_abs = os.path.dirname(os.path.abspath(compile_commands_path))
    project_root_abs = os.path.dirname(build_dir_abs)
    return build_dir_abs, project_root_abs


def list_files(cmds):
    return [entry["file"] for entry in cmds]


def list_dirs(cmds):
    return sorted({os.path.dirname(entry["file"]) for entry in cmds})


def prepare_dirs_regex(dirs, project_root_abs):
    """Return a regex group (dir1|dir2|...) of dirs relative to project root.
    If no dirs resolve (edge case), return None to match the whole tree.
    """
    rels = []
    for d in dirs:
        rel = os.path.relpath(d, project_root_abs)
        if rel == ".":
            # Files directly under the root; don't add an empty alternative
            continue
        rels.append(re.escape(rel))
    if not rels:
        return None
    return "(" + "|".join(rels) + ")"


def make_clang_tidy_cmd(build_dir, project_root_abs, files, dirs_regex):
    files_str = " ".join(files)
    root_esc = re.escape(project_root_abs)
    if dirs_regex:
        header_filter = f"'^{root_esc}/{dirs_regex}/.*'"
    else:
        header_filter = f"'^{root_esc}/.*'"
    return f"clang-tidy-19 -p {build_dir} {files_str} --header-filter={header_filter}"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__
        or "Extract data from compile_commands.json and build a clang-tidy command."
    )
    parser.add_argument("compile_commands", help="Path to compile_commands.json")
    parser.add_argument(
        "--absolute",
        "-a",
        action="store_true",
        help="Output absolute instead of relative paths",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--files", "-f", action="store_true", help="List source file paths"
    )
    group.add_argument(
        "--dirs", "-d", action="store_true", help="List directories containing sources"
    )
    group.add_argument(
        "--clang-tidy-cmd",
        "-c",
        action="store_true",
        help="Generate clang-tidy command",
    )
    args = parser.parse_args()

    cmds = load_commands(args.compile_commands)
    build_dir_abs, project_root_abs = get_project_paths(args.compile_commands)

    if args.absolute:
        build_dir = build_dir_abs
        files_out = list_files(cmds)
        dirs_out = list_dirs(cmds)
    else:
        cwd = os.getcwd()
        build_dir = os.path.relpath(build_dir_abs, cwd)
        files_out = [os.path.relpath(f, cwd) for f in list_files(cmds)]
        dirs_out = [os.path.relpath(d, cwd) for d in list_dirs(cmds)]

    if args.files:
        for path in files_out:
            print(path)
        return

    if args.dirs:
        for path in dirs_out:
            print(path)
        return

    dirs_regex = prepare_dirs_regex(list_dirs(cmds), project_root_abs)
    cmd = make_clang_tidy_cmd(build_dir, project_root_abs, files_out, dirs_regex)
    print(cmd)


if __name__ == "__main__":
    main()
