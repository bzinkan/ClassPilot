#!/bin/bash
#
# Quick deploy script for AWS Fargate
# Prerequisites: AWS CLI configured, Docker installed
#
set -e

echo "🚀 ClassPilot AWS Fargate Deployment Script"
echo "============================================"
echo ""

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO_NAME="${ECR_REPO_NAME:-classpilot}"
CLUSTER_NAME="${CLUSTER_NAME:-classpilot-cluster}"
SERVICE_NAME="${SERVICE_NAME:-classpilot-service}"

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "Configuration:"
echo "  AWS Region: ${AWS_REGION}"
echo "  AWS Account: ${AWS_ACCOUNT_ID}"
echo "  ECR Repository: ${ECR_REPO_URI}"
echo "  ECS Cluster: ${CLUSTER_NAME}"
echo "  ECS Service: ${SERVICE_NAME}"
echo ""

# Check if ECR repository exists
echo "📦 Checking ECR repository..."
if ! aws ecr describe-repositories --repository-names ${ECR_REPO_NAME} --region ${AWS_REGION} &>/dev/null; then
    echo "Creating ECR repository..."
    aws ecr create-repository --repository-name ${ECR_REPO_NAME} --region ${AWS_REGION}
else
    echo "✅ ECR repository exists"
fi

# Login to ECR
echo "🔐 Logging in to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${ECR_REPO_URI}

# Build Docker image
echo "🏗️  Building Docker image..."
docker build -t classpilot:latest .

# Tag image
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
echo "🏷️  Tagging image (commit: ${GIT_COMMIT})..."
docker tag classpilot:latest ${ECR_REPO_URI}:latest
docker tag classpilot:latest ${ECR_REPO_URI}:${GIT_COMMIT}

# Push to ECR
echo "⬆️  Pushing to ECR..."
docker push ${ECR_REPO_URI}:latest
docker push ${ECR_REPO_URI}:${GIT_COMMIT}

# Check if ECS service exists
echo "🔍 Checking ECS service..."
if aws ecs describe-services --cluster ${CLUSTER_NAME} --services ${SERVICE_NAME} --region ${AWS_REGION} | grep -q "ACTIVE"; then
    echo "✅ ECS service exists"

    # Force new deployment
    echo "🔄 Forcing new deployment..."
    aws ecs update-service \
        --cluster ${CLUSTER_NAME} \
        --service ${SERVICE_NAME} \
        --force-new-deployment \
        --region ${AWS_REGION}

    echo "⏳ Waiting for deployment to stabilize..."
    aws ecs wait services-stable \
        --cluster ${CLUSTER_NAME} \
        --services ${SERVICE_NAME} \
        --region ${AWS_REGION}

    echo "✅ Deployment successful!"
else
    echo "❌ ECS service not found. Please create it first using AWS_DEPLOYMENT.md"
    exit 1
fi

# Get service details
echo ""
echo "📊 Service Status:"
aws ecs describe-services \
    --cluster ${CLUSTER_NAME} \
    --services ${SERVICE_NAME} \
    --region ${AWS_REGION} \
    --query 'services[0].{Status:status,DesiredCount:desiredCount,RunningCount:runningCount,Deployments:deployments[*].{Status:status,TaskDefinition:taskDefinition}}' \
    --output table

echo ""
echo "🎉 Deployment complete!"
echo ""
echo "Next steps:"
echo "  1. Check CloudWatch logs: aws logs tail /ecs/classpilot --follow"
echo "  2. Verify health: curl https://your-domain.com/health"
echo "  3. Monitor in AWS Console: https://console.aws.amazon.com/ecs"
