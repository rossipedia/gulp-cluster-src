const cluster = require('cluster');
const File = require('vinyl');
const gs = require('glob-stream');
const fs = require('fs');
const through = require('through2');
const util = require('gulp-util');
const colors = require('colors');
const os = require('os');

const sendLog = message => process.send({
    type: 'log',
    message
});
const requestFile = () => process.send({
    type: 'getfile'
});

module.exports = function (gulp) {

    function getRunningTaskName() {
        return Object.keys(gulp.tasks)
            .filter(n => gulp.tasks[n].running)
            .map(n => gulp.tasks[n].name)[0];
    }

    function createWorkerPromise(currentTask, fileStream) {

        cluster.setupMaster({
            args: ['--silent', currentTask]
        });

        const worker = cluster.fork();
        util.log('spawned ' + `worker #${worker.id}`.dim.red + ' with task ' + currentTask);

        const label = worker => '[' + `worker ${worker.id}`.red + ']: ';

        const messageHandlers = {
            getfile() {
                const file = fileStream.read();
                if (file === null) {
                    this.send({
                        type: 'end'
                    });
                    return;
                }

                this.send({
                    type: 'file',
                    file
                });
            },
            log({
                message
            }) {
                util.log(label(this) + message);
            }
        }

        worker.on('message', message => messageHandlers[message.type].call(worker, message));

        return new Promise(function (resolve, reject) {
            worker.on('exit', resolve);
            worker.on('error', reject);
        });
    }


    return function (glob, opts, builder) {
        builder = typeof opts === 'function' ? opts : builder;
        opts = typeof opts === 'function' ? {} : opts;

        const taskName = getRunningTaskName();

        if (cluster.isMaster) {
            const fileStream = gs.create(glob, opts);
            const workerCount = +(opts.concurrency || os.cpus().length);

            const promises = [];
            for (let i = 0; i < workerCount; ++i)
                promises.push(createWorkerPromise.call(this, taskName, fileStream));

            return Promise.all(promises);
        } else {
            sendLog(`Task '${taskName.cyan}' STARTING`);

            const fileStream = through.obj();

            const messageHandlers = {
                file({
                    file
                }) {
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

            const pipeline = builder(fileStream)
                .pipe(through.obj(function (file, enc, done) {
                    requestFile();
                    done();
                }));

            requestFile();
            return pipeline;
        }
    };
};