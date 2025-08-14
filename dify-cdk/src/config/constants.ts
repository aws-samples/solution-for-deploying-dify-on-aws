/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

// CloudFront prefix list IDs for different regions
// These prefix lists contain the IP ranges used by CloudFront edge locations
export const CLOUDFRONT_PREFIX_LIST_IDS = {
  'us-east-1': 'pl-3b927c52',
  'us-east-2': 'pl-b6a144df',
  'us-west-1': 'pl-4ea04527',
  'us-west-2': 'pl-82a045eb',
  'ap-south-1': 'pl-9aa247f3',
  'ap-northeast-2': 'pl-22a6434b',
  'ap-southeast-1': 'pl-31a34658',
  'ap-southeast-2': 'pl-b8a742d1',
  'ap-northeast-1': 'pl-58a04531',
  'ca-central-1': 'pl-38a64351',
  'eu-central-1': 'pl-a3a144ca',
  'eu-west-1': 'pl-4fa04526',
  'eu-west-2': 'pl-93a247fa',
  'eu-west-3': 'pl-75b1541c',
  'eu-north-1': 'pl-feb65297',
  'sa-east-1': 'pl-78a54011',
} as const;

// Asset configuration
export const ASSETS_TAG_KEY = 'dify-assets';
export const ASSETS_NAME = 'DifyOnAWS';
export const ASSETS_SHORT_NAME = 'DIFY';

// Generate a 6-character random string consisting of numbers and letters
export const AWS_RESOURCE_SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();

/**
 * Instance map for the EC2 instances
 * See https://aws.amazon.com/ec2/instance-types for more information
 *
 * c - vCPUs, m - Memory in GB
 */
export const EC2_INSTANCE_MAP = {
  '2c8mg': 'm7g.large',
  '4c16mg': 'm7g.xlarge',
  '8c32mg': 'm7g.2xlarge',
  '2c8ma': 'm5a.large',
  '4c16ma': 'm5a.xlarge',
  '8c32ma': 'm5a.2xlarge',
  'large': 'm5a.large', // Default large instance
};

export const EC2_INSTANCE_GCR_MAP = {
  '2c8ma': 'm5a.large',
  '4c16ma': 'm5a.xlarge',
  '8c32ma': 'm5a.2xlarge',
  'large': 'm5a.large', // Default large instance
};

/**
 * Redis node map
 * See https://aws.amazon.com/elasticache/pricing/ for more information
 * Assume 2 vCPUs.
 *
 * c - vCPUs, m - Memory in GB
 */
export const REDIS_NODE_MAP = {
  '6.38m': 'cache.m6g.large',
  '12.93m': 'cache.m6g.xlarge',
  'large': 'cache.m6g.large', // Default large instance
};

/**
 * Aurora instance map
 * See https://aws.amazon.com/rds/aurora/pricing/ for more information
 * Please note that not all instance types may be supported in every region,
 * You can find the available instance types on the AWS RDS creation page.
 *
 * c - vCPUs, m - Memory in GB
 */
export const RDS_INSTANCE_MAP = {
  '2c8m': 'm5.large',
  '4c32m': 'r5.xlarge',
  'large': 'db.m6g.large', // Default large instance
};

/**
 * OpenSearch instance map
 * See https://aws.amazon.com/opensearch-service/pricing/ for more information
 * Please note that not all instance types may be supported in every region,
 * You can find the available instance types on the AWS OpenSearch creation page.
 *
 * c - vCPUs, m - Memory in GB
 */
export const OPENSEARCH_INSTANCE_MAP = {
  '16c64m': 'm7g.4xlarge.search',
  '8c16m': 'c6g.2xlarge.search',
  '2c8m': 'r6g.large.search',
  '4c16m': 'r6g.xlarge.search',
  'small': 't3.small.search', // Default small instance
};

/**
 * Dify versions for configuration
 */
export const DIFY_VERSIONS = [
  '1.0.0',
  '1.1.0',
  '1.2.0',
  '1.3.0',
  '1.4.0',
  '1.4.1',
  '1.4.2',
];

/**
 * Utility type for values passed to Helm or GitOps applications.
 */
export type Values = {
  [key: string]: any;
};
