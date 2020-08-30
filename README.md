[![npm version](https://badge.fury.io/js/gulp-cluster-src.svg)](https://badge.fury.io/js/gulp-cluster-src)

# Gulp Clustered File Source

Process files in parallel using node's `cluster` module.

## Why

You might have a single task in your gulpfile that processes a _lot_ of files,
and some of those files might take a _long_ time to process.

You also might be processing these files on a 8-core hyper-threaded monster of
a box, which means you have 15 cores sitting there not doing anything.

When they _could be_...

This module attempts to seamlessly add multi-core support to a _single_ task, as
opposed to [gulp-multi-process][2], which runs multiple _tasks_ in their own
process.

## Usage

```javascript
const gulp       = require('gulp');
const envify     = require('gulp-envify');
const uglify     = require('gulp-uglify');

const clusterSrc = require('gulp-cluster-src')(gulp);

gulp.task('compress:js', () =>
    clusterSrc('src/**/*.js', src =>
        src.pipe(uglify())
           .pipe(gulp.dest('dist'))
    )
);
```

## Caveats

* You _must_ return the value that `clusterSrc` returns back to gulp, so that
  gulp can detect when all the child processes are finished.

* You _must_ pass `gulp` into the function exported by `gulp-cluster-src`. This
  performs some necessary initialization steps.

## How it works

#### TL;DR

Set up a file stream in the master process, spawn multiple child
processes, hook the two up via `process.send`, and use the `pipeline` parameter
factory function in each child process to do the actual work.

#### Wat?

Read the source, Luke.

## Parameters

### `glob`
### `opts`

These parameters are passed as-is to `glob-stream`. See [that package][1] for
what options it supports.

In addition, the following options are used by this package:

#### `concurrency`

The max number of child processes to spawn. The default is
`require('os').cpus().length`.

This is a _maximum_ limit. While you _can_ specify a number greater than the
number of processors in your machine, you won't really see any benefit. Also,

#### `taskName`

We automatically try to get the currently running task name, but this can be hard to do with certain gulp setups. In that case, use this parameter to set the task name.

### Additional methods

#### `clusterSrc.logfiles()`

Creates a stream that will log the processed files. Not that `gulp-debug` _can_
be used, but you might not like the results due to multiple processes writing
to `process.stdout` at the same time.

#### `clusterSrc.log(msg)`

This is the function used by `logfiles()` to log output. It should be used
instead of `console.log` or `util.log` for writing output.

[1]: https://github.com/gulpjs/glob-stream#options
