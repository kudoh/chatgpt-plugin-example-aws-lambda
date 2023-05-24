import { APIGatewayEvent, APIGatewayProxyHandler, APIGatewayProxyResult, Context } from 'aws-lambda';
import * as fs from 'fs';

const CORSHeaders = {
  'Access-Control-Allow-Origin': 'https://chat.openai.com',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Headers': '*'
};

export const aiplugin: APIGatewayProxyHandler = async (event: APIGatewayEvent, context: Context) => {
  const plugin = fs.readFileSync('./static-local/.well-known/ai-plugin.json');
  return {
    statusCode: 200,
    body: plugin.toString(),
    headers: {
      ...CORSHeaders,
      'Content-Type': 'application/json'
    }
  };
};

export const openapi: APIGatewayProxyHandler = async (event: APIGatewayEvent, context: Context) => {
  const openapi = fs.readFileSync('./static-local/openapi.yaml');
  return {
    statusCode: 200,
    body: openapi.toString(),
    headers: {
      ...CORSHeaders,
      'Content-Type': 'application/yaml'
    }
  };
};
