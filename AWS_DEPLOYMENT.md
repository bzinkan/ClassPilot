# AWS Fargate Deployment Guide for ClassPilot

## Architecture Overview

```
Internet → Route53 → ALB (HTTPS) → Fargate Tasks → Neon PostgreSQL
                                                 ↓
                                             CloudWatch
```

## Cost Estimate (Monthly)

| Service | Configuration | Cost |
|---------|--------------|------|
| **Fargate** | 2 tasks × 0.25 vCPU, 512MB | ~$30 |
| **Application Load Balancer** | Standard | ~$20 |
| **NAT Gateway** (optional) | Single AZ | ~$35 |
| **Data Transfer** | ~50GB | ~$5 |
| **CloudWatch Logs** | 10GB | ~$5 |
| **Route53** | Hosted zone | ~$0.50 |
| **ACM Certificate** | Free | $0 |
| **Total (with NAT)** | | **~$95/month** |
| **Total (without NAT)** | | **~$60/month** |

**Scaling:** Each additional Fargate task adds ~$15/month

---

## Prerequisites

1. **AWS Account** with billing enabled
2. **AWS CLI** installed: `aws --version`
3. **Docker** installed: `docker --version`
4. **Domain name** (for SSL certificate)
5. **Neon PostgreSQL** database URL

---

## Step 1: Set Up AWS CLI

```bash
# Configure AWS credentials
aws configure

# Verify
aws sts get-caller-identity
```

---

## Step 2: Create ECR Repository

```bash
# Set variables
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO_NAME=classpilot

# Create ECR repository
aws ecr create-repository \
  --repository-name ${ECR_REPO_NAME} \
  --region ${AWS_REGION}

# Get repository URI
export ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"
echo "ECR Repository: ${ECR_REPO_URI}"
```

---

## Step 3: Build and Push Docker Image

```bash
# Login to ECR
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${ECR_REPO_URI}

# Build the image
docker build -t classpilot:latest .

# Tag the image
docker tag classpilot:latest ${ECR_REPO_URI}:latest
docker tag classpilot:latest ${ECR_REPO_URI}:$(git rev-parse --short HEAD)

# Push to ECR
docker push ${ECR_REPO_URI}:latest
docker push ${ECR_REPO_URI}:$(git rev-parse --short HEAD)
```

---

## Step 4: Create VPC and Networking

### Option A: Use Default VPC (Simplest)

```bash
# Get default VPC ID
export VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" \
  --output text)

# Get default subnets
export SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query "Subnets[*].SubnetId" \
  --output text | tr '\t' ',')

echo "VPC ID: ${VPC_ID}"
echo "Subnets: ${SUBNET_IDS}"
```

### Option B: Create Custom VPC (Recommended for Production)

```bash
# Create VPC
export VPC_ID=$(aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=classpilot-vpc}]' \
  --query 'Vpc.VpcId' \
  --output text)

# Enable DNS
aws ec2 modify-vpc-attribute --vpc-id ${VPC_ID} --enable-dns-support
aws ec2 modify-vpc-attribute --vpc-id ${VPC_ID} --enable-dns-hostnames

# Create Internet Gateway
export IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=classpilot-igw}]' \
  --query 'InternetGateway.InternetGatewayId' \
  --output text)

aws ec2 attach-internet-gateway --vpc-id ${VPC_ID} --internet-gateway-id ${IGW_ID}

# Create public subnets (2 for high availability)
export SUBNET_1=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.1.0/24 \
  --availability-zone ${AWS_REGION}a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=classpilot-public-1}]' \
  --query 'Subnet.SubnetId' \
  --output text)

export SUBNET_2=$(aws ec2 create-subnet \
  --vpc-id ${VPC_ID} \
  --cidr-block 10.0.2.0/24 \
  --availability-zone ${AWS_REGION}b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=classpilot-public-2}]' \
  --query 'Subnet.SubnetId' \
  --output text)

# Create route table
export RTB_ID=$(aws ec2 create-route-table \
  --vpc-id ${VPC_ID} \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=classpilot-public-rt}]' \
  --query 'RouteTable.RouteTableId' \
  --output text)

# Add route to internet
aws ec2 create-route --route-table-id ${RTB_ID} --destination-cidr-block 0.0.0.0/0 --gateway-id ${IGW_ID}

# Associate subnets with route table
aws ec2 associate-route-table --subnet-id ${SUBNET_1} --route-table-id ${RTB_ID}
aws ec2 associate-route-table --subnet-id ${SUBNET_2} --route-table-id ${RTB_ID}

export SUBNET_IDS="${SUBNET_1},${SUBNET_2}"
```

---

## Step 5: Create Security Groups

```bash
# Security group for ALB
export ALB_SG=$(aws ec2 create-security-group \
  --group-name classpilot-alb-sg \
  --description "Security group for ClassPilot ALB" \
  --vpc-id ${VPC_ID} \
  --query 'GroupId' \
  --output text)

# Allow HTTP and HTTPS from anywhere
aws ec2 authorize-security-group-ingress --group-id ${ALB_SG} --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id ${ALB_SG} --protocol tcp --port 443 --cidr 0.0.0.0/0

# Security group for Fargate tasks
export FARGATE_SG=$(aws ec2 create-security-group \
  --group-name classpilot-fargate-sg \
  --description "Security group for ClassPilot Fargate tasks" \
  --vpc-id ${VPC_ID} \
  --query 'GroupId' \
  --output text)

# Allow traffic from ALB only
aws ec2 authorize-security-group-ingress \
  --group-id ${FARGATE_SG} \
  --protocol tcp \
  --port 5000 \
  --source-group ${ALB_SG}
```

---

## Step 6: Create Application Load Balancer

```bash
# Create ALB
export ALB_ARN=$(aws elbv2 create-load-balancer \
  --name classpilot-alb \
  --subnets ${SUBNET_1} ${SUBNET_2} \
  --security-groups ${ALB_SG} \
  --scheme internet-facing \
  --type application \
  --ip-address-type ipv4 \
  --tags Key=Name,Value=classpilot-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text)

# Get ALB DNS name
export ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns ${ALB_ARN} \
  --query 'LoadBalancers[0].DNSName' \
  --output text)

echo "ALB DNS: ${ALB_DNS}"

# Create target group
export TG_ARN=$(aws elbv2 create-target-group \
  --name classpilot-tg \
  --protocol HTTP \
  --port 5000 \
  --vpc-id ${VPC_ID} \
  --target-type ip \
  --health-check-path /health \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)

# Create HTTP listener (will redirect to HTTPS later)
aws elbv2 create-listener \
  --load-balancer-arn ${ALB_ARN} \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=${TG_ARN}
```

---

## Step 7: Request SSL Certificate (ACM)

```bash
# Replace with your domain
export DOMAIN_NAME=classpilot.net

# Request certificate
export CERT_ARN=$(aws acm request-certificate \
  --domain-name ${DOMAIN_NAME} \
  --subject-alternative-names "*.${DOMAIN_NAME}" \
  --validation-method DNS \
  --query 'CertificateArn' \
  --output text)

echo "Certificate ARN: ${CERT_ARN}"

# Get DNS validation records
aws acm describe-certificate --certificate-arn ${CERT_ARN}

# Add the CNAME records to your DNS provider
# Wait for validation (can take 5-30 minutes)

# Check validation status
aws acm describe-certificate \
  --certificate-arn ${CERT_ARN} \
  --query 'Certificate.Status' \
  --output text
```

**After certificate is validated:**

```bash
# Add HTTPS listener
aws elbv2 create-listener \
  --load-balancer-arn ${ALB_ARN} \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=${CERT_ARN} \
  --default-actions Type=forward,TargetGroupArn=${TG_ARN}

# Update HTTP listener to redirect to HTTPS
export HTTP_LISTENER_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn ${ALB_ARN} \
  --query "Listeners[?Port==\`80\`].ListenerArn" \
  --output text)

aws elbv2 modify-listener \
  --listener-arn ${HTTP_LISTENER_ARN} \
  --default-actions Type=redirect,RedirectConfig="{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}"
```

---

## Step 8: Create ECS Cluster and Task Definition

```bash
# Create ECS cluster
aws ecs create-cluster --cluster-name classpilot-cluster

# Create IAM role for task execution
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Get role ARN
export TASK_EXEC_ROLE_ARN=$(aws iam get-role \
  --role-name ecsTaskExecutionRole \
  --query 'Role.Arn' \
  --output text)
```

Create task definition file (`task-definition.json`):

```json
{
  "family": "classpilot",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "TASK_EXEC_ROLE_ARN_HERE",
  "containerDefinitions": [{
    "name": "classpilot",
    "image": "ECR_REPO_URI_HERE:latest",
    "essential": true,
    "portMappings": [{
      "containerPort": 5000,
      "protocol": "tcp"
    }],
    "environment": [
      {"name": "NODE_ENV", "value": "production"},
      {"name": "PORT", "value": "5000"}
    ],
    "secrets": [
      {"name": "DATABASE_URL", "valueFrom": "classpilot/DATABASE_URL"},
      {"name": "SESSION_SECRET", "valueFrom": "classpilot/SESSION_SECRET"},
      {"name": "STUDENT_TOKEN_SECRET", "valueFrom": "classpilot/STUDENT_TOKEN_SECRET"},
      {"name": "GOOGLE_CLIENT_ID", "valueFrom": "classpilot/GOOGLE_CLIENT_ID"},
      {"name": "GOOGLE_CLIENT_SECRET", "valueFrom": "classpilot/GOOGLE_CLIENT_SECRET"},
      {"name": "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", "valueFrom": "classpilot/GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY"},
      {"name": "WS_SHARED_KEY", "valueFrom": "classpilot/WS_SHARED_KEY"}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/classpilot",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "node -e \"require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\""],
      "interval": 30,
      "timeout": 10,
      "retries": 3,
      "startPeriod": 40
    }
  }]
}
```

**Store secrets in AWS Systems Manager Parameter Store:**

```bash
# Generate secure secrets
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export STUDENT_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export WS_SHARED_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# Store in Parameter Store (SecureString)
aws ssm put-parameter --name "classpilot/DATABASE_URL" --value "YOUR_NEON_DATABASE_URL" --type SecureString
aws ssm put-parameter --name "classpilot/SESSION_SECRET" --value "${SESSION_SECRET}" --type SecureString
aws ssm put-parameter --name "classpilot/STUDENT_TOKEN_SECRET" --value "${STUDENT_TOKEN_SECRET}" --type SecureString
aws ssm put-parameter --name "classpilot/WS_SHARED_KEY" --value "${WS_SHARED_KEY}" --type SecureString
aws ssm put-parameter --name "classpilot/GOOGLE_CLIENT_ID" --value "YOUR_GOOGLE_CLIENT_ID" --type SecureString
aws ssm put-parameter --name "classpilot/GOOGLE_CLIENT_SECRET" --value "YOUR_GOOGLE_CLIENT_SECRET" --type SecureString
aws ssm put-parameter --name "classpilot/GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY" --value "${GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY}" --type SecureString

# Grant ECS task execution role access to parameters
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name AccessSSMParameters \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["ssm:GetParameters", "secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:ssm:'${AWS_REGION}':'${AWS_ACCOUNT_ID}':parameter/classpilot/*"
    }]
  }'
```

**Create CloudWatch log group:**

```bash
aws logs create-log-group --log-group-name /ecs/classpilot
```

**Register task definition:**

```bash
# Replace placeholders
sed -i "s|TASK_EXEC_ROLE_ARN_HERE|${TASK_EXEC_ROLE_ARN}|g" task-definition.json
sed -i "s|ECR_REPO_URI_HERE|${ECR_REPO_URI}|g" task-definition.json
sed -i "s|us-east-1|${AWS_REGION}|g" task-definition.json

# Register
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

---

## Step 9: Create ECS Service

```bash
# Create service
aws ecs create-service \
  --cluster classpilot-cluster \
  --service-name classpilot-service \
  --task-definition classpilot \
  --desired-count 2 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_1},${SUBNET_2}],securityGroups=[${FARGATE_SG}],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=${TG_ARN},containerName=classpilot,containerPort=5000" \
  --health-check-grace-period-seconds 60
```

---

## Step 10: Configure DNS (Route53)

```bash
# Create hosted zone (if not exists)
export HOSTED_ZONE_ID=$(aws route53 create-hosted-zone \
  --name ${DOMAIN_NAME} \
  --caller-reference $(date +%s) \
  --query 'HostedZone.Id' \
  --output text)

# Create alias record to ALB
cat > route53-record.json <<EOF
{
  "Changes": [{
    "Action": "CREATE",
    "ResourceRecordSet": {
      "Name": "${DOMAIN_NAME}",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "$(aws elbv2 describe-load-balancers --load-balancer-arns ${ALB_ARN} --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)",
        "DNSName": "${ALB_DNS}",
        "EvaluateTargetHealth": true
      }
    }
  }]
}
EOF

aws route53 change-resource-record-sets \
  --hosted-zone-id ${HOSTED_ZONE_ID} \
  --change-batch file://route53-record.json
```

---

## Step 11: Enable Auto-Scaling (Optional but Recommended)

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/classpilot-cluster/classpilot-service \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10

# Create scaling policy based on CPU
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id service/classpilot-cluster/classpilot-service \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name cpu-scaling-policy \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    },
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

---

## Monitoring & Maintenance

### View Logs

```bash
aws logs tail /ecs/classpilot --follow
```

### Check Service Status

```bash
aws ecs describe-services \
  --cluster classpilot-cluster \
  --services classpilot-service
```

### Update Application

```bash
# Build and push new image
docker build -t classpilot:latest .
docker tag classpilot:latest ${ECR_REPO_URI}:latest
docker push ${ECR_REPO_URI}:latest

# Force new deployment
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --force-new-deployment
```

---

## Cost Optimization Tips

1. **Use Fargate Spot** (50-70% savings):
   ```bash
   --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1
   ```

2. **Reduce task size during off-hours**:
   - Set up CloudWatch Events to scale down at night

3. **Use AWS Savings Plans**:
   - 1-year commitment: ~20% savings
   - 3-year commitment: ~30% savings

4. **Skip NAT Gateway**:
   - Use public subnets with `assignPublicIp=ENABLED`
   - Save $35/month per NAT Gateway

5. **Optimize CloudWatch Logs**:
   - Set retention to 7 days: `aws logs put-retention-policy --log-group-name /ecs/classpilot --retention-in-days 7`

---

## Troubleshooting

### Task fails to start

```bash
# Check task logs
aws ecs describe-tasks \
  --cluster classpilot-cluster \
  --tasks $(aws ecs list-tasks --cluster classpilot-cluster --service-name classpilot-service --query 'taskArns[0]' --output text)
```

### Health checks failing

- Check `/health` endpoint returns 200
- Verify security group allows ALB → Fargate on port 5000
- Check CloudWatch logs for application errors

### High costs

- Review CloudWatch billing dashboard
- Check Fargate task count (should be 2-4)
- Verify NAT Gateway usage
- Review data transfer costs

---

## Production Checklist

- [ ] SSL certificate validated and HTTPS listener configured
- [ ] All environment variables stored in Parameter Store
- [ ] Auto-scaling configured (min: 2, max: 10)
- [ ] CloudWatch alarms set up for CPU, memory, errors
- [ ] Backup strategy for Neon database
- [ ] Route53 DNS pointing to ALB
- [ ] Test deployment with real traffic
- [ ] Monitor costs in AWS Cost Explorer

---

**Your application will be available at:** `https://classpilot.net`

**Estimated deployment time:** 2-3 hours for first time
