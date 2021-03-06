var fs = require("fs");
var glob = require("glob");
var mkdirp = require("mkdirp");
var os = require("os");
var pathUtil = require("path");
var Promise = require("bluebird");
var ts = require("typescript");
// declare some constants so we don't have magic integers without explanation
var DTSLEN = '.d.ts'.length;
var filenameToMid = (function () {
    if (pathUtil.sep === '/') {
        return function (filename) {
            return filename;
        };
    }
    else {
        var separatorExpression_1 = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
        return function (filename) {
            return filename.replace(separatorExpression_1, '/');
        };
    }
})();
/**
 * A helper function that takes TypeScript diagnostic errors and returns an error
 * object.
 * @param diagnostics The array of TypeScript Diagnostic objects
 */
function getError(diagnostics) {
    var message = 'Declaration generation failed';
    diagnostics.forEach(function (diagnostic) {
        // not all errors have an associated file: in particular, problems with a
        // the tsconfig.json don't; the messageText is enough to diagnose in those
        // cases.
        if (diagnostic.file) {
            var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            message +=
                "\n" + diagnostic.file.fileName + "(" + (position.line + 1) + "," + (position.character + 1) + "): " +
                    ("error TS" + diagnostic.code + ": " + diagnostic.messageText);
        }
        else {
            message += "\nerror TS" + diagnostic.code + ": " + diagnostic.messageText;
        }
    });
    var error = new Error(message);
    error.name = 'EmitterError';
    return error;
}
function getFilenames(baseDir, files) {
    return files.map(function (filename) {
        var resolvedFilename = pathUtil.resolve(filename);
        if (resolvedFilename.indexOf(baseDir) === 0) {
            return resolvedFilename;
        }
        return pathUtil.resolve(baseDir, filename);
    });
}
function processTree(sourceFile, replacer) {
    var code = '';
    var cursorPosition = 0;
    function skip(node) {
        cursorPosition = node.end;
    }
    function readThrough(node) {
        code += sourceFile.text.slice(cursorPosition, node.pos);
        cursorPosition = node.pos;
    }
    function visit(node) {
        readThrough(node);
        var replacement = replacer(node);
        if (replacement != null) {
            code += replacement;
            skip(node);
        }
        else {
            ts.forEachChild(node, visit);
        }
    }
    visit(sourceFile);
    code += sourceFile.text.slice(cursorPosition);
    return code;
}
/**
 * Load and parse a TSConfig File
 * @param options The dts-generator options to load config into
 * @param fileName The path to the file
 */
function getTSConfig(options, fileName) {
    // TODO this needs a better design than merging stuff into options.
    // the trouble is what to do when no tsconfig is specified...
    var configText = fs.readFileSync(fileName, { encoding: 'utf8' });
    var result = ts.parseConfigFileTextToJson(fileName, configText);
    if (result.error) {
        throw getError([result.error]);
    }
    var configObject = result.config;
    var configParseResult = ts.parseJsonConfigFileContent(configObject, ts.sys, pathUtil.dirname(fileName));
    if (configParseResult.errors && configParseResult.errors.length) {
        throw getError(configParseResult.errors);
    }
    return [
        configParseResult.fileNames,
        configParseResult.options
    ];
}
function isNodeKindImportDeclaration(value) {
    return value && value.kind === ts.SyntaxKind.ImportDeclaration;
}
function isNodeKindExternalModuleReference(value) {
    return value && value.kind === ts.SyntaxKind.ExternalModuleReference;
}
function isNodeKindStringLiteral(value) {
    return value && value.kind === ts.SyntaxKind.StringLiteral;
}
function isNodeKindExportDeclaration(value) {
    return value && value.kind === ts.SyntaxKind.ExportDeclaration;
}
function isNodeKindExportAssignment(value) {
    return value && value.kind === ts.SyntaxKind.ExportAssignment;
}
function isNodeKindModuleDeclaration(value) {
    return value && value.kind === ts.SyntaxKind.ModuleDeclaration;
}
function generate(options) {
    var noop = function (message) {
        var optionalParams = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            optionalParams[_i - 1] = arguments[_i];
        }
    };
    var sendMessage = options.sendMessage || noop;
    var verboseMessage = options.verbose ? sendMessage : noop;
    var compilerOptions = {};
    var files = options.files;
    /* following tsc behaviour, if a project is specified, or if no files are specified then
     * attempt to load tsconfig.json */
    if (options.project || !options.files || options.files.length === 0) {
        verboseMessage("project = \"" + (options.project || options.baseDir) + "\"");
        // if project isn't specified, use baseDir.  If it is and it's a directory,
        // assume we want tsconfig.json in that directory.  If it is a file, though
        // use that as our tsconfig.json.  This allows for projects that have more
        // than one tsconfig.json file.
        var tsconfigFilename = void 0;
        if (Boolean(options.project)) {
            if (fs.lstatSync(options.project).isDirectory()) {
                tsconfigFilename = pathUtil.join(options.project, 'tsconfig.json');
            }
            else {
                // project isn't a diretory, it's a file
                tsconfigFilename = options.project;
            }
        }
        else {
            tsconfigFilename = pathUtil.join(options.baseDir, 'tsconfig.json');
        }
        if (fs.existsSync(tsconfigFilename)) {
            verboseMessage("  parsing \"" + tsconfigFilename + "\"");
            _a = getTSConfig(options, tsconfigFilename), files = _a[0], compilerOptions = _a[1];
        }
        else {
            sendMessage("No \"tsconfig.json\" found at \"" + tsconfigFilename + "\"!");
            return new Promise(function (resolve, reject) {
                reject(new SyntaxError('Unable to resolve configuration.'));
            });
        }
    }
    var eol = options.eol || os.EOL;
    var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
    var indent = options.indent === undefined ? '\t' : options.indent;
    // use input values if tsconfig leaves any of these undefined.
    // this is for backwards compatibility
    compilerOptions.declaration = true;
    compilerOptions.target = compilerOptions.target || ts.ScriptTarget.Latest; // is this necessary?
    compilerOptions.moduleResolution = compilerOptions.moduleResolution || options.moduleResolution;
    compilerOptions.outDir = compilerOptions.outDir || options.outDir;
    // TODO should compilerOptions.baseDir come into play?
    var baseDir = pathUtil.resolve(compilerOptions.rootDir || options.project || options.baseDir);
    var outDir = compilerOptions.outDir;
    verboseMessage("baseDir = \"" + baseDir + "\"");
    verboseMessage("target = " + compilerOptions.target);
    verboseMessage("outDir = " + compilerOptions.outDir);
    verboseMessage("rootDir = " + compilerOptions.rootDir);
    verboseMessage("moduleResolution = " + compilerOptions.moduleResolution);
    var filenames = getFilenames(baseDir, files);
    verboseMessage('filenames:');
    filenames.forEach(function (name) { verboseMessage('  ' + name); });
    var excludesMap = {};
    options.exclude = options.exclude || ['node_modules/**/*.d.ts'];
    options.exclude && options.exclude.forEach(function (filename) {
        glob.sync(filename).forEach(function (globFileName) {
            excludesMap[filenameToMid(pathUtil.resolve(baseDir, globFileName))] = true;
        });
    });
    if (options.exclude) {
        verboseMessage('exclude:');
        options.exclude.forEach(function (name) { verboseMessage('  ' + name); });
    }
    mkdirp.sync(pathUtil.dirname(options.out));
    /* node.js typings are missing the optional mode in createWriteStream options and therefore
     * in TS 1.6 the strict object literal checking is throwing, therefore a hammer to the nut */
    var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
    var host = ts.createCompilerHost(compilerOptions);
    var program = ts.createProgram(filenames, compilerOptions, host);
    function writeFile(filename, data, writeByteOrderMark) {
        // Compiler is emitting the non-declaration file, which we do not care about
        if (filename.slice(-DTSLEN) !== '.d.ts') {
            return;
        }
        writeDeclaration(ts.createSourceFile(filename, data, compilerOptions.target, true), true);
    }
    var declaredExternalModules = [];
    return new Promise(function (resolve, reject) {
        output.on('close', function () { resolve(undefined); });
        output.on('error', reject);
        if (options.externs) {
            options.externs.forEach(function (path) {
                sendMessage("Writing external dependency " + path);
                output.write("/// <reference path=\"" + path + "\" />" + eol);
            });
        }
        if (options.types) {
            options.types.forEach(function (type) {
                sendMessage("Writing external @types package dependency " + type);
                output.write("/// <reference types=\"" + type + "\" />" + eol);
            });
        }
        sendMessage('processing:');
        var mainExportDeclaration = false;
        var mainExportAssignment = false;
        program.getSourceFiles().forEach(function (sourceFile) {
            processTree(sourceFile, function (node) {
                if (isNodeKindModuleDeclaration(node)) {
                    var name_1 = node.name;
                    if (isNodeKindStringLiteral(name_1)) {
                        declaredExternalModules.push(name_1.text);
                    }
                }
                return null;
            });
        });
        program.getSourceFiles().some(function (sourceFile) {
            // Source file is a default library, or other dependency from another project, that should not be included in
            // our bundled output
            if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
                return;
            }
            if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
                return;
            }
            sendMessage("  " + sourceFile.fileName);
            // Source file is already a declaration file so should does not need to be pre-processed by the emitter
            if (sourceFile.fileName.slice(-DTSLEN) === '.d.ts') {
                writeDeclaration(sourceFile, false);
                return;
            }
            // We can optionally output the main module if there's something to export.
            if (options.main && options.main === (options.name + filenameToMid(sourceFile.fileName.slice(baseDir.length, -3)))) {
                ts.forEachChild(sourceFile, function (node) {
                    mainExportDeclaration = mainExportDeclaration || isNodeKindExportDeclaration(node);
                    mainExportAssignment = mainExportAssignment || isNodeKindExportAssignment(node);
                });
            }
            var emitOutput = program.emit(sourceFile, writeFile);
            if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
                reject(getError(emitOutput.diagnostics
                    .concat(program.getSemanticDiagnostics(sourceFile))
                    .concat(program.getSyntacticDiagnostics(sourceFile))
                    .concat(program.getDeclarationDiagnostics(sourceFile))));
                return true;
            }
        });
        if (options.main && options.name) {
            console.log(options.name);
            output.write("declare module '" + options.name + "' {" + eol + indent);
            if (compilerOptions.target >= ts.ScriptTarget.ES2015) {
                if (mainExportAssignment) {
                    output.write("export {default} from '" + options.main + "';" + eol + indent);
                }
                if (mainExportDeclaration) {
                    output.write("export * from '" + options.main + "';" + eol);
                }
            }
            else {
                output.write("import main = require('" + options.main + "');" + eol + indent);
                output.write('export = main;' + eol);
            }
            output.write('}' + eol);
            sendMessage("Aliased main module " + options.name + " to " + options.main);
        }
        sendMessage("output to \"" + options.out + "\"");
        output.end();
    });
    function writeDeclaration(declarationFile, isOutput) {
        // resolving is important for dealting with relative outDirs
        var filename = pathUtil.resolve(declarationFile.fileName);
        // use the outDir here, not the baseDir, because the declarationFiles are
        // outputs of the build process; baseDir points instead to the inputs.
        // However we have to account for .d.ts files in our inputs that this code
        // is also used for.  Also if no outDir is used, the compiled code ends up
        // alongside the source, so use baseDir in that case too.
        var outputDir = (isOutput && Boolean(outDir)) ? pathUtil.resolve(outDir) : baseDir;
        var sourceModuleId = options.name ? options.name + filenameToMid(filename.slice(outputDir.length, -DTSLEN)) : filenameToMid(filename.slice(outputDir.length + 1, -DTSLEN));
        var currentModuleId = filenameToMid(filename.slice(outputDir.length + 1, -DTSLEN));
        function resolveModuleImport(moduleId) {
            var isDeclaredExternalModule = declaredExternalModules.indexOf(moduleId) !== -1;
            if (options.resolveModuleImport) {
                var resolved = options.resolveModuleImport({
                    importedModuleId: moduleId,
                    currentModuleId: currentModuleId,
                    isDeclaredExternalModule: isDeclaredExternalModule
                });
                if (resolved) {
                    return resolved;
                }
            }
            if (moduleId.charAt(0) === '.') {
                return filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), moduleId));
            }
        }
        /* For some reason, SourceFile.externalModuleIndicator is missing from 1.6+, so having
         * to use a sledgehammer on the nut */
        if (declarationFile.externalModuleIndicator) {
            var resolvedModuleId = sourceModuleId;
            if (options.resolveModuleId) {
                var resolveModuleIdResult = options.resolveModuleId({
                    currentModuleId: currentModuleId
                });
                if (resolveModuleIdResult) {
                    resolvedModuleId = resolveModuleIdResult;
                }
            }
            if (resolvedModuleId === options.name + '/index') {
                resolvedModuleId = resolvedModuleId.replace('/index', '');
            }
            output.write('declare module \'' + resolvedModuleId + '\' {' + eol + indent);
            var content = processTree(declarationFile, function (node) {
                if (isNodeKindExternalModuleReference(node)) {
                    var expression = node.expression;
                    var resolved = resolveModuleImport(expression.text);
                    if (resolved) {
                        return ' require(\'' + resolved + '\')';
                    }
                }
                else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
                    return '';
                }
                else if (isNodeKindStringLiteral(node) && node.parent &&
                    (isNodeKindExportDeclaration(node.parent) || isNodeKindImportDeclaration(node.parent))) {
                    var text = node.text;
                    var resolved = resolveModuleImport(text);
                    if (resolved) {
                        return " '" + resolved + "'";
                    }
                }
            });
            output.write(content.replace(nonEmptyLineStart, '$&' + indent));
            output.write(eol + '}' + eol);
        }
        else {
            output.write(declarationFile.text);
        }
    }
    var _a;
}
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = generate;