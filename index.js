const cluster = require('cluster');
const File = require('vinyl');
const gs = require('glob-stream');
const fs = require('fs');
const through = require('through2');
const util = require('gulp-util');
const os = require('os');
const minimist = require('minimist');

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
}

/**
 * IPC function helpers
 */
function sendLog(message) {
    process.send({
        type: 'log',
        message
    });
}
function requestFile() {
    process.send({
        type: 'getfile'
    });
}

function sendFile(worker, file) {
    worker.send({
        type: 'file',
        file
    });
}

function sendDone(worker) {
    worker.send({
        type: 'end'
    });
}

/**
 * Fork our gulpfile and kick off the task.
 * Returns a Promise that resolves when the process ends.
 */
function createWorker(worker, task, args, handlers) {
    cluster.setupMaster({
        args: [...args, '--silent', task]
    });

    const worker = cluster.fork();
    util.log(
        'spawned ' +
        `worker #${worker.id}`.dim.red +
        ' with task ' +
        task
    );

    worker.on('message', message => {
        handlers[message.type].call(worker, message)
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
            util.log(
                '[' + `worker ${worker.id}`.red + ']: ' +
                msg.message
            );
        }
    }

    const promises = [];
    for (let i = 0; i < workerCount; ++i) {
        promises.push(createWorker(
            taskName,
            getWorkerArgs(),
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
function createWorkerFilestream(taskName) {
    const fileStream = through.obj();
    const messageHandlers = {
        file(msg) {
            const file = msg.file;
            file.contents = fs.readFileSync(file.path);
            fileStream.push(new File(file));
        },
        end() {
            fileStream.push(null); // We done
            sendLog(`Task '${taskName.cyan}' DONE`);
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
        .pipe(through.obj((file, enc, done) => {
            requestFile();
            done();
        }));

    // Let's kick things off
    requestFile();
    return pipeline;
}

module.exports = function (gulp) {

    /**
     * Get the running task name by checking each task registered in
     * gulp.tasks for the `running` property.
     */
    function getRunningTaskName() {
        return Object.keys(gulp.tasks)
            .filter(n => gulp.tasks[n].running)
            .map(n => gulp.tasks[n].name)[0];
    }

    if (cluster.isWorker) {
        gulp.on('start', function () {
            /*
            We have to hack up gulp's (really Orchestrator's) dependency and
            task tree in the child process to make it appear as though the
            task we want to run in parallel is the *only* task in the gulpfile.
            Since the task dependencies have already been processed in the
            parent process, we don't want to run them *again* in the forked
            worker process.

            This is probably *completely* unsupported and will likely break
            in the future.
            */
            const task = gulp.tasks[argv._];
            task.dep = []; // No dependencies
            gulp.tasks = { [argv._]: task }; // only a single task
            gulp.seq = [argv._]; // only this task is queued
        });
    }

    /**
     * The main attraction
     */
    function clusterSrc(glob, opts, builder) {
        builder = typeof opts === 'function' ? opts : builder;
        opts = typeof opts === 'function' ? {} : opts;

        const taskName = getRunningTaskName();

        if (cluster.isMaster) {
            const workerCount = +(opts.concurrency || os.cpus().length);
            const fileStream = gs.create(glob, opts);
            return spawnWorkers(taskName, workerCount, fileStream);
        } else {
            sendLog(`Task '${taskName.cyan}' STARTING`);
            return setupChildPipeline(taskName, builder);
        }
    };

    /**
     * Convenience plugin to list processed files out from parent process.
     * Child processes are invoked with --silent, so they can't output things
     * directly.
     */
    clusterSrc.logfiles = through.obj((file, enc, done) => {
        sendLog(file.path);
        done(null, file);
    });

    /**
     * Expose this for custom pipelines
     */
    clusterSrc.log = sendLog;

    return clusterSrc;
};