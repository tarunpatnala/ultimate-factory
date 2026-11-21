/** Stage output sink (stdout by default). Tests replace `out.write` to keep reporters clean. */
export const out = {
  write: (s: string): void => {
    process.stdout.write(s);
  },
};
