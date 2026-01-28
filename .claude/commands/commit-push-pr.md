# Commit, Push, and Create PR

Execute a complete git workflow: commit changes, push to remote, and create a pull request.

## Instructions

Follow these steps carefully:

### 1. Check Current State

Run these commands in parallel to understand the current state:

```bash
git status
git diff --staged
git diff
git log -3 --oneline
git branch --show-current
```

### 2. Verify Branch Name Convention

This repository requires branches to follow the format: `YYYY_MM_DD_feature-name`

- If on `main` branch with uncommitted changes, ask the user for a feature name and create a new branch following the convention
- If already on a feature branch, continue with the workflow
- Use today's date for new branches

### 3. Stage and Commit Changes

If there are unstaged changes:
- Stage all relevant files with `git add`
- Do NOT commit files that likely contain secrets (.env, credentials.json, etc.)

Create a commit with:
- A concise message (1-2 sentences) focusing on "why" rather than "what"
- Include the co-author line at the end:
  ```
  Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
  ```

Use HEREDOC format for the commit message:
```bash
git commit -m "$(cat <<'EOF'
Commit message here.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

### 4. Push to Remote

Push the branch to the remote with upstream tracking:

```bash
git push -u origin <branch-name>
```

### 5. Create Pull Request

Create a PR using the GitHub CLI with this format:

```bash
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points summarizing the changes>

## Test plan
- [ ] Ran `npm run type-check` successfully
- [ ] Ran `npm run lint` successfully
- [ ] Manual smoke testing completed
- [ ] <additional testing items as relevant>

---
Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

### 6. Report Results

After completion, provide:
- The commit hash
- The PR URL
- A brief summary of what was committed

## Important Notes

- NEVER run `git push --force` or destructive commands
- NEVER skip pre-commit hooks (no `--no-verify`)
- Ask the user for confirmation if there are any concerns about the changes
- If there are no changes to commit, inform the user and stop
- Always run `npm run type-check` before committing to catch TypeScript errors
