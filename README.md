# base-and-head

> [!NOTE]
> This project is greatly inspired by [paths-filter](https://github.com/dorny/paths-filter). Many thanks to the original author for sharing such a wonderful open-source project.


When running jobs in GitHub Actions, there are many cases where you need information about files that have changed between the base commit (or branch) and the head commit (or branch). Projects like [paths-filter](https://github.com/dorny/paths-filter) and [changed-files](https://github.com/tj-actions/changed-files) are well-known examples that address this need.

However, there are situations where you need the base commit and head commit themselves rather than the changed files. For example, when using the `--affected` flag in [Turborepo](https://turbo.build/repo/docs), you can specify the base and head using environment variables like this:

```shell
TURBO_SCM_BASE=development TURBO_SCM_HEAD=main turbo ls --affected
```

This action can meet such needs by detecting the base commit, head commit, and their merge base, and outputting them.

## Example

```yaml
- name: Get base and head
  id: get-base-and-head
  uses: tarao1006/base-and-head@v0

- name: Check affected packages
  id: check
  run: |
    TURBO_SCM_BASE=${{ steps.get-base-and-head.outputs.base }} TURBO_SCM_HEAD=${{ steps.get-base-and-head.outputs.head }} turbo ls --affected
```

## Inputs

```yaml
- id: get-base-and-head
  uses: tarao1006/base-and-head@v0
  with:
    # If both base and head are defined, this action can be used to detect and retrieve the merge base.
    # Both are optional, and it is also possible to specify only one of them.
    # Type: string
    base: ''
    head: ''
```

## Outputs

- `base` - The base commit.
- `head` - The head commit.
- `merge-base` - The merge base of the base and head commits.
- `depth` - The number of commits between the merge base and the head commit.
