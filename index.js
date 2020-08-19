const Vinyl = require('vinyl');
const assert = require('assert');
const cluster = require('cluster');
const fs = require('fs');
const globStream = require('glob-stream');
const log = require('fancy-log');
const minimist = require('minimist');
const os = require('os');
const through2 = require('through2');

require('colors');

/*
    Grab all the options, but ignore the task names passed on the parent
    command line, since we'll be supplying our own task name in the
    child process.
*/
const argv = minimist(process.argv.slice(2));

function getWorkerArgs() {
    const args = [];
    const names = Object.keys(argv);
    for (let k of names) {
        if (k === '_')
            continue;

        if (k.length === 1) {
            args.push(`-${k}=${JSON.stringify(argv[k])}`);
        } else {
            args.push(`--${k}`);
            args.push(argv[k]);
        }
    }

    return args;
}

/**
 * IPC function helpers
 */
function sendLog(message) {
    if (cluster.isMaster) {
        throw new Error(
            'sendLog() cannot be called from master process.'
        );
    }

    process.send({
        type: 'log',
        message
    });
}

function sendRaw(message) {
    if (cluster.isMaster) {
        throw new Error(
            'sendRaw() cannot be called from master process.'
        );
    }

    process.send({
        type: 'raw',
        message
    });
}

function requestFile() {
    if (cluster.isMaster) {
        throw new Error(
            'requestFile() cannot be called from master process.'
        );
    }

    process.send({
        type: 'getfile'
    });
}

function sendFile(worker, file) {
    if (cluster.isWorker) {
        throw new Error(
            'sendFile() cannot be called from worker process.'
        );
    }

    worker.send({
        type: 'file',
        file
    });
}

function sendDone(worker) {
    if (cluster.isWorker) {
        throw new Error(
            'sendDone() cannot be called from worker process.'
        );
    }

    worker.send({
        type: 'end'
    });
}

/**
 * Fork our gulpfile and kick off the task.
 * Returns a Promise that resolves when the process ends.
 */
function createWorker(task, args, handlers) {
    cluster.setupMaster({
        args: [task, ...args, '--silent']
    });

    const worker = cluster.fork();
    /*log(
        'spawned ' +
        `worker #${worker.id}`.dim.red +
        ' with task ' +
        task
    );*/

    worker.on('message', message => {
        handlers[message.type](worker, message)
    });

    return new Promise(function (resolve, reject) {
        worker.on('exit', resolve);
        worker.on('error', reject);
    });
}

/**
 * Sets up the IPC message handlers, and spawn `workerCount` child processes
 * to actually process the files.
 */
function spawnWorkers(taskName, workerCount, fileStream) {
    const handlers = {
        getfile(worker) {
            const file = fileStream.read();
            if (file === null) {
                sendDone(worker);
                return;
            }

            sendFile(worker, file);
        },

        log(worker, msg) {
            log(
                '[' + `worker ${worker.id}`.red + ']: ' +
                msg.message
            );
        },

        raw(worker, msg) {
            console.log(msg.message);
        },

        error(worker, msg) {
            if (cluster.isMaster)
            {
                throw new Error(msg.message.error.message);
            }
        }
    }

    const workerArgs = getWorkerArgs();
    log(
        `spawning ${workerCount.toString().yellow} worker ` +
        `processes for task ${taskName.cyan }`
    );

    const promises = [];
    for (let i = 0; i < workerCount; ++i) {
        promises.push(createWorker(
            taskName,
            workerArgs,
            handlers
        ));
    }

    return Promise.all(promises);
}

/**
 * Creates a vinyl stream from messages received from the cluster IPC channel.
 * We read the file's contents in here, because sending file contents over the
 * IPC channel would be really dumb.
 */
function createWorkerFilestream() {
    const fileStream = through2.obj();
    const messageHandlers = {
        file(msg) {
            const file = msg.file;
            file.contents = fs.readFileSync(file.path);
            fileStream.push(new Vinyl(file));
        },
        end() {
            fileStream.push(null); // We done
            //sendLog(`Task '${taskName.cyan}' DONE`);
            cluster.worker.disconnect();
        }
    }
    process.on('message', message => messageHandlers[message.type](message));
    return fileStream;
}

/**
 * The meat of the worker process
 */
function setupChildPipeline(taskName, builder) {
    const pipeline = builder(createWorkerFilestream(taskName))
        /*
        We tack this on at the tail end so that whenever we'red
        done with a file, we request a new one from the parent process.
        */
        .pipe(through2.obj((file, enc, done) => {
            requestFile();
            done();
        }));

    // Let's kick things off
    requestFile();
    return pipeline;
}

module.exports = function (gulp) {
    if (cluster.isWorker) {
        gulp.on('start', () => {
            /*
            We have to override Gulp's (really Undertaker's) dependency and
            task tree in the child process to make it appear as though the
            task we want to run in parallel is the *only* task in the gulpfile.
            Since the task dependencies have already been processed in the
            parent process, we don't want to run them *again* in the forked
            worker process.

            This is probably *completely* unsupported and will likely break
            in the future.
            */
            const [workerTaskName] = argv._;
            const { constructor: DefaultRegistry } = Object.getPrototypeOf(gulp.registry());
            const registry = new class extends DefaultRegistry {
                set(taskName, task) {
                    if (taskName === workerTaskName) {
                        return super.set(taskName, task);
                    }
                }
            };

            gulp.registry(registry);
        });

        gulp.on('error', (e) =>
        {
            cluster.worker.send({
                type: 'error',
                message: e
            })
        })
    }

    /**
     * The main attraction
     */
    function clusterSrc(globs, opts, builder) {
        builder = typeof opts === 'function' ? opts : builder;
        opts = typeof opts === 'function' ? {} : opts;

        assert(typeof opts.taskName === 'string', 'opts.taskName is not a string');

        const { taskName } = opts;
        if (cluster.isMaster) {
            const workerCount = +(opts.concurrency || os.cpus().length);
            const fileStream = globStream(globs, opts);
            return spawnWorkers(taskName, workerCount, fileStream);
        } else {
            //sendLog(`Task '${taskName.cyan}' STARTING`);
            return setupChildPipeline(taskName, builder);
        }
    }

    /**
     * Convenience plugin to list processed files out from parent process.
     * Child processes are invoked with --silent, so they can't output things
     * directly.
     */
    clusterSrc.logfiles = () => {
        if (cluster.isMaster) {
            throw new Error(
                'logfiles() cannot be called from the master process'
            );
        }

        return through2.obj((file, enc, done) => {
            sendLog(file.path);
            done(null, file);
        });
    }

    /**
     * Expose this for custom pipelines
     */
    clusterSrc.log = (msg) => {
        if (cluster.isWorker)
            sendLog(msg);
        else
            log(msg);
    }

    clusterSrc.raw = (msg) => {
        if (cluster.isWorker)
            sendRaw(msg);
        else
            console.log(msg);
    };

    return clusterSrc;
};
