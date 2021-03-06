import vscode, { Uri } from 'vscode';
import * as path from 'path';
import { CredentialController } from './credential/credentialController';
import { uriHandler, EXTENSION_ID } from './shared';
import { PlatformInformation } from './common/platformInformation';
import { ensureRuntimeDependencies } from './dependency/dependencyManager';
import { DocsStatusBarObserver } from './observers/docsStatusBarObserver';
import { DocsLoggerObserver } from './observers/docsLoggerObserver';
import { DiagnosticController } from './build/diagnosticController';
import { BuildController } from './build/buildController';
import { DocsOutputChannelObserver } from './observers/docsOutputChannelObserver';
import { ErrorMessageObserver } from './observers/errorMessageObserver';
import { InfoMessageObserver } from './observers/infoMessageObserver';
import ExtensionExports from './common/extensionExport';
import { EventStream } from './common/eventStream';
import { KeyChain } from './credential/keyChain';
import { DocsEnvironmentController } from './common/docsEnvironmentController';
import { BuildStatusBarObserver } from './observers/buildStatusBarObserver';
import { CodeActionProvider } from './codeAction/codeActionProvider';
import { ExtensionContext } from './extensionContext';
import config from './config';
import { EnvironmentController } from './common/environmentController';
import { TelemetryObserver } from './observers/telemetryObserver';
import { getCorrelationId } from './utils/utils';
import { QuickPickTriggered, QuickPickCommandSelected } from './common/loggingEvents';
import TelemetryReporter from './telemetryReporter';
import { OPBuildAPIClient } from './build/opBuildAPIClient';
import { BuildExecutor } from './build/buildExecutor';
import { DocsLogger } from './common/docsLogger';

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionExports> {
    const eventStream = new EventStream();
    const extensionContext = new ExtensionContext(context);
    const environmentController = await DocsEnvironmentController.CreateAsync(eventStream);
    const platformInformation = await PlatformInformation.getCurrent();

    // Telemetry
    const telemetryReporter = getTelemetryReporter(extensionContext, environmentController);
    const telemetryObserver = new TelemetryObserver(telemetryReporter);
    eventStream.subscribe(telemetryObserver.eventHandler);

    // Output Channel and logger
    const outputChannel = vscode.window.createOutputChannel('Docs Validation');
    const docsOutputChannelObserver = new DocsOutputChannelObserver(outputChannel);

    const logger = new DocsLogger(outputChannel, extensionContext, environmentController);
    const docsLoggerObserver = new DocsLoggerObserver(logger);
    eventStream.subscribe(docsLoggerObserver.eventHandler);
    eventStream.subscribe(docsOutputChannelObserver.eventHandler);

    let runtimeDependenciesInstalled = await ensureRuntimeDependencies(extensionContext, getCorrelationId(), platformInformation, eventStream);
    if (!runtimeDependenciesInstalled) {
        throw new Error('Installation of run-time dependencies failed. Please restart Visual Studio Code to re-trigger the installation.');
    }

    // Message 
    let errorMessageObserver = new ErrorMessageObserver();
    let infoMessageObserver = new InfoMessageObserver(environmentController);
    eventStream.subscribe(errorMessageObserver.eventHandler);
    eventStream.subscribe(infoMessageObserver.eventHandler);

    // Credential component initialize
    let keyChain = new KeyChain(environmentController);
    let credentialController = new CredentialController(keyChain, eventStream, environmentController);
    eventStream.subscribe(credentialController.eventHandler);
    // Initialize credential
    let credentialInitialPromise = credentialController.initialize(getCorrelationId());

    // Docs Status bar
    let docsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_VALUE + 1);
    let docsStatusBarObserver = new DocsStatusBarObserver(docsStatusBar, environmentController);
    eventStream.subscribe(docsStatusBarObserver.eventHandler);

    // Build component initialize
    let diagnosticController = new DiagnosticController();
    let opBuildAPIClient = new OPBuildAPIClient(environmentController);
    let buildExecutor = new BuildExecutor(extensionContext, platformInformation, environmentController, eventStream, telemetryReporter);
    let buildController = new BuildController(buildExecutor, opBuildAPIClient, diagnosticController, environmentController, eventStream);

    // Build status bar
    let buildStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_VALUE);
    let buildStatusBarObserver = new BuildStatusBarObserver(buildStatusBar);
    eventStream.subscribe(buildStatusBarObserver.eventHandler);

    let codeActionProvider = new CodeActionProvider();

    context.subscriptions.push(
        outputChannel,
        logger,
        telemetryReporter,
        diagnosticController,
        docsStatusBar,
        buildStatusBar,
        environmentController,
        vscode.commands.registerCommand('docs.signIn', () => credentialController.signIn(getCorrelationId())),
        vscode.commands.registerCommand('docs.signOut', () => credentialController.signOut(getCorrelationId())),
        vscode.commands.registerCommand('docs.build', () => {
            buildController.build(getCorrelationId(), credentialController.credential);
        }),
        vscode.commands.registerCommand('docs.cancelBuild', () => buildController.cancelBuild()),
        vscode.commands.registerCommand('learnMore', (diagnosticErrorCode: string) => {
            CodeActionProvider.learnMoreAboutCode(eventStream, getCorrelationId(), diagnosticErrorCode);
        }),
        vscode.commands.registerCommand('docs.validationQuickPick', () => createQuickPickMenu(getCorrelationId(), eventStream, credentialController, buildController)),
        vscode.commands.registerCommand('docs.openInstallationDirectory', () => {
            vscode.commands.executeCommand('revealFileInOS', Uri.file(path.resolve(context.extensionPath, ".logs")));
        }),
        vscode.languages.registerCodeActionsProvider('*', codeActionProvider, {
            providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds
        }),
        vscode.window.registerUriHandler(uriHandler)
    );

    return {
        initializationFinished: async () => {
            await credentialInitialPromise;
        },
        eventStream,
        keyChain
    };
}

function getTelemetryReporter(context: ExtensionContext, environmentController: EnvironmentController): TelemetryReporter {
    let key = config.AIKey[environmentController.env];
    let telemetryReporter = new TelemetryReporter(EXTENSION_ID, context.extensionVersion, key);
    return telemetryReporter;
}

function createQuickPickMenu(correlationId: string, eventStream: EventStream, credentialController: CredentialController, buildController: BuildController) {
    eventStream.post(new QuickPickTriggered(correlationId));
    const quickPickMenu = vscode.window.createQuickPick();
    const currentSignInStatus = credentialController.credential.signInStatus;
    let pickItems: vscode.QuickPickItem[] = [];

    if (buildController.instanceAvailable) {
        pickItems.push(
            {
                label: '$(debug-start) Validate',
                description: 'Trigger a validation on current repository'
            });
    } else {
        pickItems.push(
            {
                label: '$(debug-stop) Cancel Build',
                description: 'Cancel the current validation'
            });
    }

    if (currentSignInStatus === 'SignedOut') {
        pickItems.push(
            {
                label: '$(sign-in) Sign-in',
                description: 'Sign in to Docs (!This is only available for Microsoft internal user)',
                picked: true
            });
    } else if (currentSignInStatus === 'SignedIn') {
        pickItems.push(
            {
                label: '$(sign-out) Sign-out',
                description: 'Sign out from Docs',
                picked: true
            });
    }

    quickPickMenu.placeholder = "Which command would you like to run?";
    quickPickMenu.items = pickItems;
    quickPickMenu.onDidChangeSelection(selection => {
        if (selection[0]) {
            eventStream.post(new QuickPickCommandSelected(correlationId, selection[0].label));
            switch (selection[0].label) {
                case '$(sign-in) Sign-in':
                    credentialController.signIn(getCorrelationId());
                    break;
                case '$(sign-out) Sign-out':
                    credentialController.signOut(getCorrelationId());
                    break;
                case '$(debug-start) Validate':
                    buildController.build(getCorrelationId(), credentialController.credential);
                    break;
                case '$(debug-stop) Cancel Build':
                    buildController.cancelBuild();
                    break;
            }
            quickPickMenu.hide();
        }
    });
    quickPickMenu.onDidHide(() => quickPickMenu.dispose());
    quickPickMenu.show();
}

export function deactivate() { }
