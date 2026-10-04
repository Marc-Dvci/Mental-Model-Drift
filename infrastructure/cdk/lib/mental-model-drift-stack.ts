/**
 * The deployed topology.
 *
 * The shape follows from one privacy decision and one reliability decision.
 *
 * Privacy: Bee data is owner-encrypted and stays on the wearer's machine. The
 * relay next to `bee proxy` is the only thing that reads it, and it makes
 * *outbound* calls in. Nothing in this stack can reach into Bee, and there is
 * no inbound path to the laptop. What crosses the boundary is one redacted
 * sentence per utterance, never a transcript.
 *
 * Reliability: ingestion is a queue, not a synchronous call. A live utterance
 * must never be lost because a verifier was slow or a source was down, and the
 * DLQ plus the cursor reconciliation in the worker are the two independent
 * recoveries -- one for our failures, one for Bee's at-most-once stream.
 *
 *      relay (laptop, next to bee proxy)
 *          |  outbound HTTPS
 *      API Gateway  ->  ingest Lambda  ->  SQS  ->  worker Lambda
 *                                                       |
 *                        AppConfig / Sentry / GitHub  <--+--> DynamoDB (single table)
 *                                   Bedrock  <-----------+
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface MentalModelDriftStackProps extends StackProps {
  /** Bedrock model id for the extraction proposer. */
  readonly modelId?: string;
  /** AppConfig application the demo registry points at. */
  readonly appConfigApplication?: string;
}

export class MentalModelDriftStack extends Stack {
  constructor(scope: Construct, id: string, props: MentalModelDriftStackProps = {}) {
    super(scope, id, props);

    const modelId = props.modelId ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';

    // ---------------------------------------------------------------- storage
    //
    // Single table. A claim, the evidence rows it produced and the drift it
    // became share a partition, so opening a card is one query rather than
    // three. `gsi1` exists only to fetch a claim or a drift by its own id,
    // which is what every URL in the dashboard is keyed by.
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Processed-event markers expire: idempotency has to hold for as long as
      // the stream and the reconciliation pass can disagree, which is hours.
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -------------------------------------------------------------- ingestion
    //
    // The DLQ is not decoration. An utterance that fails verification three
    // times is a bug in this system, and it has to be recoverable without
    // asking the wearer to say the sentence again.
    const deadLetter = new sqs.Queue(this, 'IngestDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, 'IngestQueue', {
      visibilityTimeout: Duration.seconds(120),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetter, maxReceiveCount: 3 },
    });

    const secrets = new secretsmanager.Secret(this, 'SourceCredentials', {
      description: 'GitHub and Sentry tokens used by the verification adapters',
      secretObjectValue: {},
    });

    // esbuild bundles the handler and everything it imports from packages/, so
    // what is deployed is the same source the tests run against rather than a
    // copy that can quietly diverge.
    const common: nodejs.NodejsFunctionProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: '../lambda/index.ts',
      projectRoot: '../..',
      depsLockFilePath: '../../pnpm-lock.yaml',
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', sourceMap: true, minify: false },
      architecture: lambda.Architecture.ARM_64,
      environment: {
        MMD_MODE: 'live',
        MMD_DYNAMO_TABLE: table.tableName,
        MMD_QUEUE_URL: queue.queueUrl,
        MMD_SECRETS_ARN: secrets.secretArn,
        MMD_BEDROCK_MODEL_ID: modelId,
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
    };

    /**
     * Ingest does as little as possible: authenticate, redact, enqueue.
     *
     * Verification takes as long as the slowest source, and a wearable feed
     * must not be blocked behind it -- so the fast path ends here, and
     * everything that can fail happens on the other side of the queue.
     */
    // A log group per function, with a retention nobody has to remember to set.
    // Utterance text never reaches these logs; see docs/privacy.md.
    const logGroupFor = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const ingest = new nodejs.NodejsFunction(this, 'IngestFunction', {
      ...common,
      handler: 'ingest',
      logGroup: logGroupFor('Ingest'),
      timeout: Duration.seconds(10),
      memorySize: 256,
    });
    queue.grantSendMessages(ingest);
    table.grantReadWriteData(ingest);

    const worker = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      ...common,
      handler: 'worker',
      logGroup: logGroupFor('Worker'),
      timeout: Duration.seconds(90),
      memorySize: 1024,
    });
    worker.addEventSource(new lambdaEventSources.SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }));
    table.grantReadWriteData(worker);
    secrets.grantRead(worker);

    const api = new nodejs.NodejsFunction(this, 'ApiFunction', { ...common, handler: 'api', logGroup: logGroupFor('Api') });
    table.grantReadWriteData(api);
    secrets.grantRead(api);
    queue.grantSendMessages(api);

    // ------------------------------------------------------------- entitlement
    //
    // Bedrock is scoped to the one model the extraction proposer uses. The
    // proposer never decides whether a statement is true -- it only maps a
    // sentence onto a registry property -- so this is the whole of the model's
    // blast radius.
    const invokeModel = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${modelId}`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    });
    worker.addToRolePolicy(invokeModel);
    api.addToRolePolicy(invokeModel);

    // AppConfig is the authoritative source for configuration and feature
    // state, and it is read-only from here. This product reports on production;
    // it does not change it.
    const readAppConfig = new iam.PolicyStatement({
      actions: [
        'appconfig:StartConfigurationSession',
        'appconfig:GetLatestConfiguration',
        'appconfig:ListHostedConfigurationVersions',
        'appconfig:GetHostedConfigurationVersion',
        'appconfig:GetConfigurationProfile',
        'appconfig:ListApplications',
      ],
      resources: ['*'],
    });
    worker.addToRolePolicy(readAppConfig);
    api.addToRolePolicy(readAppConfig);

    // --------------------------------------------------------------- frontdoor
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: 'Mental Model Drift ingest and dashboard API',
      corsPreflight: { allowOrigins: ['http://127.0.0.1:4310'], allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST] },
    });
    httpApi.addRoutes({
      path: '/api/ingest',
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('IngestIntegration', ingest),
    });
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('ApiIntegration', api),
    });

    // ------------------------------------------------- the demo's own sources
    //
    // The registry in demo/ points at these. Deploying them means the same code
    // path that reads a JSON mirror on disk in local mode reads a real deployed
    // configuration in live mode, with nothing in between changing.
    const application = new appconfig.CfnApplication(this, 'DemoApplication', {
      name: props.appConfigApplication ?? 'ecommerce',
      description: 'Demo application whose deployed configuration is the source of truth for drift',
    });
    const environment = new appconfig.CfnEnvironment(this, 'DemoEnvironment', {
      applicationId: application.ref,
      name: 'production',
    });
    const profile = new appconfig.CfnConfigurationProfile(this, 'CheckoutWorkerProfile', {
      applicationId: application.ref,
      name: 'checkout-worker',
      locationUri: 'hosted',
      type: 'AWS.Freeform',
    });
    const flagsProfile = new appconfig.CfnConfigurationProfile(this, 'FeatureFlagsProfile', {
      applicationId: application.ref,
      name: 'feature-flags',
      locationUri: 'hosted',
      type: 'AWS.Freeform',
    });
    void environment;
    void profile;
    void flagsProfile;

    // ------------------------------------------------------------ observability
    //
    // The metrics worth watching are not throughput. They are: how much was
    // heard, how little was acted on, and how often the wearer said a card was
    // wrong -- the last one being the only honest measure of extraction quality.
    const metric = (name: string, statistic = 'Sum') =>
      new cloudwatch.Metric({ namespace: 'MentalModelDrift', metricName: name, statistic, period: Duration.minutes(5) });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: 'MentalModelDrift' });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bee ingestion',
        left: [metric('BeeEventsReceived'), metric('BeeEventsReconciled'), metric('BeeEventsDeduplicated')],
      }),
      new cloudwatch.GraphWidget({
        title: 'Claims and verdicts',
        left: [metric('ClaimsDetected'), metric('DriftsDetected'), metric('ClaimsSupported'), metric('ClaimsInconclusive')],
      }),
      new cloudwatch.GraphWidget({
        title: 'Source health',
        left: [metric('AWS_APPCONFIGErrors'), metric('GITHUBErrors'), metric('SENTRYErrors')],
      }),
      new cloudwatch.SingleValueWidget({ title: 'Dismissed as not my belief', metrics: [metric('ClaimFalsePositiveFeedback')] }),
    );

    new cloudwatch.Alarm(this, 'FalsePositiveAlarm', {
      // If people are dismissing cards, the gate is too loose. That is a
      // product emergency, not a quality metric to review next quarter.
      metric: metric('ClaimFalsePositiveFeedback'),
      threshold: 3,
      evaluationPeriods: 1,
      alarmDescription: 'Wearers are marking drift cards as not their belief',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'DeadLetterAlarm', {
      metric: deadLetter.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'An utterance failed verification three times and was parked',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
