declare module 'run-series' {
  function series(tasks: any[], callback: (err: any, results: any) => void): void;
  export = series;
}