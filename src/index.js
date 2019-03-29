const {
    cli,
    is,
    std,
    app: { mainCommand, Subsystem }
} = adone;

const Benchmark = require("./benchmark");

const formatNumber = (number) => {
    number = String(number).split(".");
    return number[0].replace(/(?=(?:\d{3})+$)(?!\b)/g, ",") + (number[1] ? `.${number[1]}` : "");
};

export default class extends Subsystem {
    @mainCommand({
        arguments: [
            { name: "script", help: "path to script with suites", nargs: "?", default: "index.js" }
        ],
        options: [
            { name: "--async", help: "run suites asynchronously" },
            {
                name: "--version",
                help: "show version of benchmarking code",
                handler: () => {
                    console.log(Benchmark.version);
                    return 0;
                }
            },
            {
                name: "--db",
                holder: "PATH",
                nargs: 1,
                help: "use database to compare results"
            },
            {
                name: "--init-count",
                holder: "N",
                help: "The default number of times to execute a test on a benchmark’s first cycle",
                type: Number
            },
            {
                name: "--max-time",
                holder: "N",
                help: "The maximum time a benchmark is allowed to run before finishing (secs)",
                type: Number
            },
            {
                name: "--min-time",
                holder: "N",
                help: "The time needed to reduce the percent uncertainty of measurement to 1% (secs)",
                type: Number
            },
            {
                name: "--min-samples",
                holder: "N",
                help: "The minimum sample size required to perform statistical analysis",
                type: Number
            },
            {
                name: "--defer",
                help: "A flag to indicate that the benchmark clock is deferred"
            },
            {
                name: "--suite",
                nargs: 1,
                help: "A regexp to filter suites"
            }
        ]
    })
    async bench(args, opts) {
        let scriptPath = args.get("script");
        if (!std.path.isAbsolute(scriptPath)) {
            scriptPath = std.path.resolve(process.cwd(), scriptPath);
        }

        const benchModule = adone.require(scriptPath);

        this.filename = std.path.basename(scriptPath, ".js");
        this.async = Boolean(opts.get("async"));

        console.log(`File: '${scriptPath}'`);
        console.log(`System: '${adone.metrics.system.toString()}'`);
        console.log(`Options: async=${this.async}`);
        console.log();

        if (is.function(benchModule.init)) {
            console.log("Initializing...");
            await benchModule.init();
            console.log();
        }

        const formatEventMessage = (event, oldResult) => {
            const { target } = event;

            const size = target.stats.sample.length;
            let message = `> ${formatNumber(target.hz.toFixed(target.hz < 100 ? 2 : 0))}`;
            if (oldResult) {
                const diff = target.hz - oldResult[target.name].hz;
                const percent = (diff / oldResult[target.name].hz * 100).toFixed(2);
                if (diff >= 0) {
                    message += cli.parse(` ({#4CAF50-fg}+${formatNumber(diff.toFixed(diff < 100 ? 2 : 0))} : +${percent}%{/})`);
                } else {
                    message += cli.parse(` ({#F44336-fg}${formatNumber(diff.toFixed(diff > -100 ? 2 : 0))} : ${percent}%{/})`);
                }
            }
            message += ` ops/sec ±${target.stats.rme.toFixed(2)}% (${size} run${size === 1 ? "" : "s"} sampled)`;
            if (oldResult) {
                const diff = target.stats.sample.length - oldResult[target.name].sampleLength;
                if (diff >= 0) {
                    message += cli.parse(` ({#4CAF50-fg}+${diff}{/})`);
                } else {
                    message += cli.parse(` ({#F44336-fg}${diff}{/})`);
                }
            }
            return `${message} : ${target.name}`;
        };

        const defaultOptions = {
            defer: opts.get("defer"),
            onCycle: (event) => {
                cli.column(0);
                cli.eraseLine();
                cli.write(`${formatEventMessage(event)}`);
            },
            onComplete: () => {
                cli.column(0);
                cli.eraseLine();
            }
        };

        for (const key of ["minSamples", "minTime", "maxTime", "initCount"]) {
            if (opts.has(key)) {
                defaultOptions[key] = opts.get(key);
            }
        }

        let suites;

        if (is.object(benchModule.default)) {
            suites = benchModule.default;
        } else if (is.object(benchModule.suites)) {
            suites = benchModule.suites;
        }

        const dbPath = opts.get("db");
        const db = dbPath ? new adone.database.local.Datastore({
            filename: dbPath
        }) : null;

        if (db) {
            await db.load();
        }

        suites = this._getSuites(suites, defaultOptions);

        if (opts.has("suite")) {
            const re = new RegExp(opts.get("suite"));
            suites = suites.filter((x) => re.test(x.name));
        }

        for (const suite of suites) {
            cli.print(`Suite: {escape}${suite.name}{/escape}\n`);
            const result = {};
            let oldResult = db ? await db.findOne({ name: suite.name }) : null;  // eslint-disable-line
            if (oldResult) {
                oldResult = oldResult.result;
            }
            await new Promise((resolve, reject) => {  // eslint-disable-line
                suite
                    .on("error", reject)
                    .on("cycle", (event) => {
                        const { target } = event;

                        result[target.name] = {
                            hz: target.hz,
                            sampleLength: target.stats.sample.length
                        };
                        cli.write(`${formatEventMessage(event, oldResult)}\n`);
                    })
                    .on("complete", function onComplete() {
                        console.log(`Fastest is ${this.filter("fastest").map("name")}`);
                        console.log();
                        resolve();
                    })
                    .run({ async: this.async });
            });
            if (db && !oldResult) {
                await db.insert({ name: suite.name, result });  // eslint-disable-line
            }
        }
        return 0;
    }

    _getSuites(funcs, defaultOptions, suiteName = this.filename) {
        const suites = [];
        const suite = new Benchmark.Suite(suiteName);
        for (const [name, fn] of adone.util.entries(funcs)) {
            if (is.function(fn)) {
                suite.add(name, fn, defaultOptions);
            } else if (is.array(fn)) {
                suite.add(name, fn[0], adone.o(defaultOptions, fn[1]));
            } else if (is.object(fn)) {
                suites.push(...this._getSuites(fn, defaultOptions, `${suiteName} - ${name}`));
            }
        }
        if (suite.length) {
            suites.unshift(suite);
        }
        return suites;
    }
}
