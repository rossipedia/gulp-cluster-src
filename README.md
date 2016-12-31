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
const clusterSrc = require('gulp-cluster-src');
const envify     = require('gulp-envify');
const uglify     = require('gulp-uglify');

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

* Currently there should only be one task running at any given time that calls
  `clusterSrc`. I'd like to add the ability to manage multiple streams
  concurrently at some point in the future.

* However, you _can_ run several `clusterSrc` tasks in sequence.

## How it works

#### TL;DR

Set up a file stream in the master process, spawn multiple child
processes, hook the two up via `process.send`, and use the `pipeline` parameter
factory function in the each child process to do the actual work.

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



[1]: https://github.com/gulpjs/glob-stream#options