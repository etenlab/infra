import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

import {
  EcsExecutionRole,
  EcsTaskRole,
  ApplicationLoadBalancer,
  ProjectVpc,
} from '../components';
import { importHostedZone } from '../helpers';

interface DNSConfig {
  existingRootHostedZone: string;
  createEnvHostedZone: Boolean;
  rootDomainCertSsmParam: string;
  envDomainCertSsmParam: string;
}

/**
 * Properties required to create shared project infrastructure
 */
export interface CommonStackProps extends cdk.StackProps {
  /** Name of the application assigned to logical id of CloudFormation components */
  readonly appPrefix: string;

  /** Name of the deployed environment */
  readonly envName: string;

  /** VPC CIDR block */
  readonly cidr: string;

  /** SSM param name to store VPC id */
  readonly vpcSsmParam: string;

  /** SSM param name to store ECS execution role ARN */
  readonly ecsExecRoleSsmParam: string;

  /** SSM param name to store ECS task role ARN */
  readonly ecsTaskRoleSsmParam: string;

  /** Name of the ECS cluster to create */
  readonly ecsClusterName: string;

  /** SSM param name to store ALB ARN */
  readonly albArnSsmParam: string;

  /** SSM param name to store ALB Listener */
  readonly albListenerSsmParam: string;

  /** SSM param name to store ALB security group id */
  readonly albSecurityGroupSsmParam: string;

  /** Number of nat gateways to create */
  readonly natGatewaysCount: number;

  /** Whether to create a separate hosted zone for deployed environment */
  readonly createEnvHostedZone?: boolean;

  /** Subdomain name for deployed environment.*/
  readonly envSubdomain: string;

  readonly dns: DNSConfig[];
}

/**
 * Creates shared project infrastructure including:
 *
 * 1. Application VPC
 * 2. Application Load Balancer
 * 3. ECS cluster and default ECS IAM roles
 * 4. [Optional] Route53 public hosted zone for env domain
 *
 */
export class CommonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CommonStackProps) {
    super(scope, id, props);

    /** VPC */
    const vpc = new ProjectVpc(this, `${props.appPrefix}AppVpc`, {
      cidr: props.cidr,
      vpcName: `${props.envName}-vpc`,
      natGatewaysCount: props.natGatewaysCount,
    });

    new ssm.StringParameter(this, `${props.appPrefix}VpcIdSSMParam`, {
      stringValue: vpc.getVpcId(),
      description: 'Application VPC Id',
      parameterName: props.vpcSsmParam,
    });

    /** ECS cluster */
    const cluster = new ecs.Cluster(this, `${props.appPrefix}Cluster`, {
      vpc: vpc.getVpc(),
      clusterName: props.ecsClusterName,
      containerInsights: true,
    });

    /** ECS execution role */
    const defaultExecutionRole = new EcsExecutionRole(
      this,
      `${props.appPrefix}EcsExecutionRole`,
      { envName: props.envName },
    );

    new ssm.StringParameter(this, `${props.appPrefix}EcsExecRoleSsmParam`, {
      stringValue: defaultExecutionRole.getRoleArn(),
      description: 'Default ECS execution role',
      parameterName: props.ecsExecRoleSsmParam,
    });

    /** ECS task role */
    const defaultTaskRole = new EcsTaskRole(
      this,
      `${props.appPrefix}EcsTaskRole`,
      { envName: props.envName },
    );

    new ssm.StringParameter(this, `${props.appPrefix}EcsTaskRoleSsmParam`, {
      stringValue: defaultTaskRole.getRoleArn(),
      description: 'Default ECS task role',
      parameterName: props.ecsTaskRoleSsmParam,
    });

    /**
     * Create Route53 hosted zones.
     * Note that root hosted zone must already exist in the deployed environment.
     */
    const albCertificates = new Set<string>()
    props.dns.forEach((dnsConfig) => {
      const {
        existingRootHostedZone: rootHzName,
        createEnvHostedZone,
        rootDomainCertSsmParam,
        envDomainCertSsmParam,
      } = dnsConfig;

      const rootHzPrefix = `${props.appPrefix}${rootHzName}`;
      const envHzPrefix = `${props.appPrefix}${props.envSubdomain}${rootHzName}`;

      const rootHostedZone = importHostedZone(
        this,
        rootHzName,
        `${rootHzPrefix}RootHz`,
      );

      const rootHzCertificate = new acm.Certificate(
        this,
        `${rootHzPrefix}Cert`,
        {
          domainName: rootHzName,
          subjectAlternativeNames: [`*.${rootHzName}`],
          validation: acm.CertificateValidation.fromDns(rootHostedZone),
        },
      );

      new ssm.StringParameter(this, `${rootHzPrefix}CertSsmParam`, {
        stringValue: rootHzCertificate.certificateArn,
        description: `Certificate arn for ${rootHzName}`,
        parameterName: rootDomainCertSsmParam,
      });
      albCertificates.add(rootHzCertificate.certificateArn)


      if (createEnvHostedZone) {
        const envDomainName = `${props.envSubdomain}.${rootHzName}`
        const envHostedZone = new route53.PublicHostedZone(
          this,
          `${envHzPrefix}PublicHz`,
          {
            zoneName: envDomainName,
            comment: `Public hosted zone for ${envHzPrefix}`,
          },
        );

        /**
         * Add NS records to the existing root hosted zone
         * to enable DNS validation for env certificate.
         */
        const rootZoneNsRecord = new route53.NsRecord(
          this,
          `${envHzPrefix}RootNSRecord`,
          {
            zone: rootHostedZone,
            recordName: envDomainName,
            values: envHostedZone.hostedZoneNameServers || [],
            ttl: cdk.Duration.minutes(30),
          },
        );

        const certificate = new acm.Certificate(this, `${envHzPrefix}Cert`, {
          domainName: envDomainName,
          subjectAlternativeNames: [`*.${envDomainName}`],
          validation: acm.CertificateValidation.fromDns(envHostedZone),
        });

        new ssm.StringParameter(this, `${envHzPrefix}CertSsmParam`, {
          stringValue: certificate.certificateArn,
          description: `Certificate arn for ${envHzPrefix}`,
          parameterName: envDomainCertSsmParam,
        });

        albCertificates.add(certificate.certificateArn)
      }
    });

    /** Load balancer */
    const alb = new ApplicationLoadBalancer(this, `${props.appPrefix}Alb`, {
      loadBalancerName: `${props.envName}-alb`,
      vpc: vpc.getVpc(),
      certificateArns: [...albCertificates]
    });

    new ssm.StringParameter(this, `${props.appPrefix}AlbSsmParam`, {
      stringValue: alb.getAlbArn(),
      description: 'Application load balancer ARN',
      parameterName: props.albArnSsmParam,
    });

    new ssm.StringParameter(this, `${props.appPrefix}AlbSgIdSsmParam`, {
      stringValue: alb.getAlbSecurityGroupId(),
      description: 'Application load balancer security group id',
      parameterName: props.albSecurityGroupSsmParam,
    });

    new ssm.StringParameter(this, `${props.appPrefix}AlbListenerSsmParam`, {
      stringValue: alb.getAlbListenerArn(),
      description: 'Application load balancer HTTPS listener ARN',
      parameterName: props.albListenerSsmParam,
    });
  }
}
