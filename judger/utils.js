const
    fs = require('fs'),
    path = require('path'),
    parse = require('shell-quote').parse,
    _ = require('lodash'),
    EventEmitter = require('events'),
    { FormatError } = require('./error'),
    max = (a, b) => (a > b ? a : b),
    TIME_RE = /^([0-9]+(?:\.[0-9]*)?)([mu]?)s?$/i,
    TIME_UNITS = { '': 1000, 'm': 1, 'u': 0.001 },
    MEMORY_RE = /^([0-9]+(?:\.[0-9]*)?)([kmg])b?$/i,
    MEMORY_UNITS = { 'k': 0.1, 'm': 1, 'g': 1024 },
    EMPTY_STR = /^[ \r\n\t]*$/i;

async function copyFolder(src, dst) {
    if (!fs.existsSync(dst)) mkdirp(dst);
    if (!fs.existsSync(src)) return false;
    let dirs = fs.readdirSync(src);
    for (let item of dirs) {
        let item_path = path.join(src, item);
        let temp = fs.statSync(item_path);
        if (temp.isFile()) fs.copyFileSync(item_path, path.join(dst, item));
        else if (temp.isDirectory()) await copyFolder(item_path, path.join(dst, item));
    }
}
function parseTimeMS(str) {
    let match = TIME_RE.exec(str);
    if (!match) throw new FormatError(str, 'error parsing time');
    return parseInt(parseFloat(match[1]) * TIME_UNITS[match[2]]);
}
function parseMemoryMB(str) {
    let match = MEMORY_RE.exec(str);
    if (!match) throw new FormatError(str, 'error parsing memory');
    return parseInt(parseFloat(match[1]) * MEMORY_UNITS[match[2]]);
}
function sleep(timeout) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}
function rmdir(path, recursive = true) {
    if (!fs.existsSync(path)) return;
    if (recursive)
        fs.readdirSync(path).forEach(file => {
            let curPath = path + '/' + file;
            if (fs.statSync(curPath).isDirectory()) rmdir(curPath);
            else fs.unlinkSync(curPath);
        });
    fs.rmdirSync(path);
}
function cleandir(path) {
    if (fs.existsSync(path))
        fs.readdirSync(path).forEach(file => {
            let curPath = path + '/' + file;
            if (fs.statSync(curPath).isDirectory()) rmdir(curPath);
            else fs.unlinkSync(curPath);
        });
}
function mkdirp(p) {
    p = path.resolve(p);
    try {
        fs.mkdirSync(p);
    } catch (err0) {
        if (err0.code == 'ENOENT') {
            mkdirp(path.dirname(p));
            fs.mkdirSync(p);
        } else {
            let stat;
            try {
                stat = fs.statSync(p);
            } catch (err1) {
                throw err0;
            }
            if (!stat.isDirectory()) throw err0;
        }
    }
}
function parseFilename(path) {
    let t = path.split('/');
    return t[t.length - 1];
}
class Queue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.waiting = [];
    }
    get(count = 1) {
        if (this.empty() || this.queue.length < count)
            return new Promise(resolve => {
                this.waiting.push({ count, resolve });
            });
        let items = [];
        for (let i = 0; i < count; i++)
            items.push(this.queue[i]);
        this.queue = _.drop(this.queue, count);
        return items;
    }
    empty() {
        return this.queue.length == 0;
    }
    push(value) {
        this.queue.push(value);
        if (this.waiting.length && this.waiting[0].count <= this.queue.length) {
            let items = [];
            for (let i = 0; i < this.waiting[0].count; i++)
                items.push(this.queue[i]);
            this.queue = _.drop(this.queue, this.waiting[0].count);
            this.waiting[0].resolve(items);
            this.waiting.shift();
        }
    }
}
function compilerText(stdout, stderr) {
    let ret = [];
    if (!EMPTY_STR.test(stdout)) ret.push(stdout);
    if (!EMPTY_STR.test(stderr)) ret.push(stderr);
    ret.push('自豪的采用 HydroJudger 进行评测(github.com/hydro-dev/HydroJudger)');
    return ret.join('\n');
}
function copyInDir(dir) {
    let files = {};
    if (fs.existsSync(dir))
        fs.readdirSync(dir).forEach(f1 => {
            let p1 = dir + '/' + f1;
            if (fs.statSync(p1).isDirectory())
                fs.readdirSync(p1).forEach(f2 => {
                    files[`${f1}/${f2}`] = { src: `${dir}/${f1}/${f2}` };
                });
            else files[f1] = { src: `${dir}/${f1}` };
        });
    return files;
}

module.exports = {
    Queue, mkdirp, max, rmdir, sleep, copyFolder, compilerText, copyInDir,
    parseMemoryMB, parseTimeMS, parseFilename, cmd: parse, cleandir
};