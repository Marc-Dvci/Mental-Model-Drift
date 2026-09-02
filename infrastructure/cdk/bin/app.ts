#!/usr/bin/env node
/**
 * CDK entry point.
 *
 *   npm install && npx cdk deploy
 *
 * Region and account come from the ambient credentials; nothing here is
 * hard-coded to one account, and the stack is deployable into an empty one.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { App } from 'aws-cdk-lib';
import { MentalModelDriftStack } from '../lib/mental-model-drift-stack.ts';

const app = new App();

new MentalModelDriftStack(app, 'MentalModelDrift', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'Mental Model Drift -- verifies spoken claims about systems against their authoritative sources',
  ...(process.env.MMD_BEDROCK_MODEL_ID ? { modelId: process.env.MMD_BEDROCK_MODEL_ID } : {}),
});
