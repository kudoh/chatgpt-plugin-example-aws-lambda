import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext('stage') || 'local';

    const preflightOptions = {
      allowMethods: apigateway.Cors.ALL_METHODS,
      allowOrigins: ['https://chat.openai.com'],
      allowHeaders: ['*']
    };

    const githubSearchFunction = new nodejs.NodejsFunction(this, 'SearchRepos', {
      functionName: this.stackName,
      entry: '../handler.ts',
      handler: 'search',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_18_X,
      environment: {
        GITHUB_TOKEN: this.node.getContext('github-token') // for testing
      }
    });

    const api = new apigateway.RestApi(this, 'GithubSearchApi', {
      restApiName: 'GitHub Search API',
      description: 'ChatGPT Plugin for GitHub Search'
    });
    const resource = api.root.addResource('api').addResource('search', {
      defaultCorsPreflightOptions: stage === "local" ? preflightOptions : undefined
    });
    resource.addMethod('GET', new apigateway.LambdaIntegration(githubSearchFunction));

    if (stage === 'local') {
      // プラグインマニフェスト・OpenAPI仕様等の静的リソースバケット
      const commandHooks = {
        afterBundling(inputDir: string, outputDir: string): string[] {
          return [`cp -r ${inputDir}/../static-local ${outputDir}`];
        },
        beforeBundling(inputDir: string, outputDir: string): string[] {
          return [];
        },
        beforeInstall(inputDir: string, outputDir: string): string[] {
          return [];
        }
      };
      const openapi = new nodejs.NodejsFunction(this, 'OpenAPI', {
        functionName: 'openapi',
        entry: '../handler-local.ts',
        handler: 'openapi',
        runtime: lambda.Runtime.NODEJS_18_X,
        bundling: {
          commandHooks
        }
      });
      api.root.addResource('openapi.yaml', {
        defaultCorsPreflightOptions: stage === "local" ? preflightOptions : undefined
      }).addMethod('GET', new apigateway.LambdaIntegration(openapi));
      const aiplugin = new nodejs.NodejsFunction(this, 'AIPlugin', {
        functionName: 'aiplugin',
        entry: '../handler-local.ts',
        handler: 'aiplugin',
        runtime: lambda.Runtime.NODEJS_18_X,
        bundling: {
          commandHooks
        }
      });
      api.root.addResource('.well-known').addResource('ai-plugin.json', {
        defaultCorsPreflightOptions: stage === "local" ? preflightOptions : undefined
      }).addMethod('GET', new apigateway.LambdaIntegration(aiplugin));
    } else if (stage === 'aws') {
      const bucket = new s3.Bucket(this, 'StaticBucket', {
        bucketName: `${this.stackName}-static-resource`,
        accessControl: s3.BucketAccessControl.PRIVATE,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // CloudFrontディストリビューション(CDN)
      const oai = new cloudfront.OriginAccessIdentity(
        this, 'StaticBucketOriginAccessIdentity');
      // const oac = new cloudfront.CfnOriginAccessControl(this, 'StaticBucketOAC', {
      //   originAccessControlConfig: {
      //     name: `${this.stackName}-oac`,
      //     originAccessControlOriginType: 's3',
      //     signingBehavior: 'always',
      //     signingProtocol: 'sigv4'
      //   }
      // });
      const apiCachePolicy = new cloudfront.CachePolicy(this, 'ChatGPTGitHubSearchCachePolicy', {
        cachePolicyName: `${this.stackName}-api-policy`,
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none()
      });
      const domainName = this.node.getContext('domain');
      const certificateArn = this.node.getContext('acm-arn');
      const certificate = acm.Certificate.fromCertificateArn(this, 'PluginCert', certificateArn);
      const distribution = new cloudfront.Distribution(this, 'ChatGPTDistribution', {
        certificate,
        domainNames: [domainName],
        // デフォルトキャッシュビヘイビア -> 静的リソースバケット(opneapi.yaml, ai-plugin.json...)
        defaultBehavior: {
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          // responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          origin: new origins.S3Origin(bucket, {
            originAccessIdentity: oai
          })
        },
        additionalBehaviors: {
          // /api配下のアクセスはAPI Gateway(Lambda)にルーティング
          'api/*': {
            origin: new origins.RestApiOrigin(api),
            cachePolicy: apiCachePolicy,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            // responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
          }
        }
      });
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        principals: [new iam.CanonicalUserPrincipal(
          oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')]
        // conditions: {
        //   StringEquals: {
        //     'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`
        //   }
        // }
      }));

      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        zoneName: domainName.substring(domainName.indexOf('.') + 1),
        hostedZoneId: this.node.getContext('zone-id')
      });
      new route53.ARecord(this, 'DNSRecord', {
        recordName: domainName,
        zone,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
      });

      new s3deploy.BucketDeployment(this, 'DeployWebsite', {
        sources: [s3deploy.Source.asset('../static')],
        destinationBucket: bucket
      });
      new cdk.CfnOutput(this, 'DistributionDomain', {
        value: distribution.distributionDomainName
      });
      new cdk.CfnOutput(this, 'DistributionId', {
        value: distribution.distributionId
      });
      new cdk.CfnOutput(this, 'StaticBucketName', {
        value: bucket.bucketName
      });
    }
  }
}
