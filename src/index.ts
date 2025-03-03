import * as core from "@actions/core";
import { exec, getExecOutput } from "@actions/exec";
import * as github from "@actions/github";

const runGroup = async <T>(title: string, fn: () => Promise<T>): Promise<T> => {
  core.startGroup(title);
  try {
    return fn();
  } finally {
    core.endGroup();
  }
};

const isGitSha = (ref: string): boolean => /^[a-z0-9]{40}$/.test(ref);

const getRef = async (
  name: string,
): Promise<{ sha: string; name: string } | undefined> => {
  if (isGitSha(name)) {
    return { sha: name, name };
  }

  return getExecOutput("git", ["show-ref", name]).then(({ stdout }) =>
    stdout
      .split("\n")
      .filter((s) => s !== "")
      .map((s) => {
        const [sha, name] = s.split(" ");
        return { sha, name };
      })
      .find(({ name }) =>
        new RegExp("refs/remotes/origin/.*|refs/tags/.*").test(name),
      ),
  );
};

type BaseAndHead = {
  base: string;
  head: string;
};

const getBaseAndHeadFromPullRequest = async (): Promise<BaseAndHead> => {
  const base = github.context.payload.pull_request?.base.sha;
  if (typeof base !== "string") {
    throw new Error(`Failed to get base sha from pull request`);
  }

  const head = await runGroup("Get head", async () => {
    const { stdout } = await getExecOutput("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
  });

  return { base, head };
};

const getBaseFromPush = async ({ head }: { head: string }): Promise<string> => {
  const inputBase = core.getInput("base", { required: false });
  const base = inputBase || github.context.payload.repository?.default_branch;
  if (typeof base !== "string") {
    throw new Error(`Failed to get base from push`);
  }

  if (base !== head) {
    return base;
  }

  // When merging into the default branch
  const before = github.context.payload.before;
  if (typeof before !== "string") {
    throw new Error(`Failed to get before from push`);
  }

  return before;
};

const getBaseAndHeadFromPush = async (): Promise<BaseAndHead> => {
  const head = await runGroup("Get current branch or tag", async () => {
    const inputHead = core.getInput("head", { required: false });
    if (inputHead !== "") {
      return inputHead;
    }

    const { stdout: branchShowCurrent } = await getExecOutput("git", [
      "branch",
      "--show-current",
    ]);
    const head = branchShowCurrent.trim();
    if (head !== "") {
      return head;
    }

    const { stdout: describeTagsExactMatch, exitCode } = await getExecOutput(
      "git",
      ["describe", "--tags", "--exact-match"],
      { ignoreReturnCode: true },
    );
    if (exitCode === 0) {
      return describeTagsExactMatch.trim();
    }
    return undefined;
  });
  if (head === undefined) {
    throw new Error(`Failed to get head from push`);
  }

  const base = await getBaseFromPush({ head });
  if (typeof base !== "string") {
    throw new Error(`Failed to get base from push`);
  }

  await getExecOutput("git", ["fetch", "origin", "--depth=100", base, head]);

  const baseRef = await getRef(base);
  const headRef = await getRef(head);

  if (baseRef === undefined || headRef === undefined) {
    throw new Error(`Failed to get ref`);
  }

  return {
    base: baseRef.sha,
    head: headRef.sha,
  };
};

const getBaseAndHad = async (): Promise<BaseAndHead> => {
  switch (github.context.eventName) {
    case "pull_request":
      return getBaseAndHeadFromPullRequest();
    case "push":
      return getBaseAndHeadFromPush();
    case "workflow_dispatch":
      core.warning(
        `In the case of workflow_dispatch, base and head will be empty strings.`,
      );
      return { base: "", head: "" };
    default:
      throw new Error(`Unsupported event: ${github.context.eventName}`);
  }
};

const fetchMoreAndGetCurrentDepth = async ({
  base,
  head,
}: BaseAndHead): Promise<number> => {
  await exec("git", ["fetch", "--deepen=100", "origin", base, head]);

  const { stdout } = await getExecOutput("git", [
    "rev-list",
    "--count",
    "--all",
  ]);

  const currentDepth = parseInt(stdout.trim(), 10);

  return isNaN(currentDepth) ? 0 : currentDepth;
};

const getMergeBase = async ({
  base,
  head,
  previousDepth = 0,
}: BaseAndHead & {
  previousDepth?: number;
}): Promise<string> => {
  const { stdout, exitCode } = await getExecOutput(
    "git",
    ["merge-base", base, head],
    {
      ignoreReturnCode: true,
    },
  );

  // merge-base is available
  if (exitCode === 0) {
    return stdout.trim();
  }

  const currentDepth = await fetchMoreAndGetCurrentDepth({ base, head });

  if (currentDepth === previousDepth) {
    await exec("git", ["fetch"]);
    const { stdout, exitCode } = await getExecOutput(
      "git",
      ["merge-base", base, head],
      {
        ignoreReturnCode: true,
      },
    );

    // merge-base is available
    if (exitCode === 0) {
      return stdout.trim();
    }
    throw new Error("Failed to get merge base");
  }

  return getMergeBase({
    base,
    head,
    previousDepth: currentDepth,
  });
};

const getNecessaryDepth = async ({
  base,
  head,
}: BaseAndHead): Promise<number> => {
  const { stdout } = await getExecOutput("git", [
    "rev-list",
    "--count",
    "--no-merges",
    `${base}...${head}`,
  ]);

  const count = parseInt(stdout.trim(), 10);

  if (isNaN(count)) {
    throw new Error(`Failed to get necessary depth`);
  }

  return count + 1;
};

// pull_request:
//  base: github.context.payload.pull_request.base.sha
//  head: git rev-parse HEAD
// push
//  branch
//    base: default_branch
//    head: git branch --show-current
//  tag
//    base: default_branch
//    head: git describe --tags --exact-match
const run = async () => {
  try {
    const baseAndHead = await getBaseAndHad();

    if (baseAndHead.base === "" && baseAndHead.head === "") {
      core.setOutput("base", "");
      core.setOutput("head", "");
      core.setOutput("merge-base", "");
      core.setOutput("depth", 0);
      return;
    }

    const mergeBase = await runGroup("Ensure merge base available", async () =>
      getMergeBase(baseAndHead),
    );

    const depth = await runGroup("Get necessary depth", async () => {
      const headDepth = await getNecessaryDepth({
        base: mergeBase,
        head: baseAndHead.head,
      });

      const baseDepth = await getNecessaryDepth({
        base: mergeBase,
        head: baseAndHead.base,
      });

      return Math.max(headDepth, baseDepth);
    });

    core.setOutput("base", baseAndHead.base);
    core.setOutput("head", baseAndHead.head);
    core.setOutput("merge-base", mergeBase);
    core.setOutput("depth", depth);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      throw error;
    }
  }
};

run();
