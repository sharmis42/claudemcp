import axios, { AxiosInstance } from "axios";

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

export interface FigmaFile {
  name: string;
  lastModified: string;
  version: string;
  document: FigmaNode;
}

export class FigmaClient {
  private http: AxiosInstance;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: "https://api.figma.com/v1",
      headers: { "X-Figma-Token": token },
    });
  }

  // Figma URLs use '-' in node IDs, but the API uses ':'
  normalizeNodeId(nodeId: string) {
    return nodeId.replace(/-/g, ":");
  }

  async getFile(fileKey: string): Promise<FigmaFile> {
    const { data } = await this.http.get(`/files/${fileKey}`);
    return data;
  }

  async getNode(fileKey: string, nodeId: string) {
    const id = this.normalizeNodeId(nodeId);
    const { data } = await this.http.get(`/files/${fileKey}/nodes?ids=${id}`);
    return data;
  }

  async getComponents(fileKey: string) {
    const { data } = await this.http.get(`/files/${fileKey}/components`);
    return data;
  }

  async getComponentSets(fileKey: string) {
    const { data } = await this.http.get(`/files/${fileKey}/component_sets`);
    return data;
  }

  async getStyles(fileKey: string) {
    const { data } = await this.http.get(`/files/${fileKey}/styles`);
    return data;
  }

  async getComments(fileKey: string) {
    const { data } = await this.http.get(`/files/${fileKey}/comments`);
    return data;
  }

  async postComment(
    fileKey: string,
    message: string,
    nodeId?: string,
    nodeOffsetX = 0,
    nodeOffsetY = 0
  ) {
    const body: Record<string, unknown> = { message };
    if (nodeId) {
      body.client_meta = {
        node_id: this.normalizeNodeId(nodeId),
        node_offset: { x: nodeOffsetX, y: nodeOffsetY },
      };
    }
    const { data } = await this.http.post(`/files/${fileKey}/comments`, body);
    return data;
  }

  async exportNode(
    fileKey: string,
    nodeId: string,
    format: "png" | "svg" | "jpg" = "png",
    scale = 1
  ) {
    const id = this.normalizeNodeId(nodeId);
    const { data } = await this.http.get(
      `/images/${fileKey}?ids=${id}&format=${format}&scale=${scale}`
    );
    return data as { images: Record<string, string>; err?: string };
  }

  async getVariables(fileKey: string) {
    const { data } = await this.http.get(`/files/${fileKey}/variables/local`);
    return data;
  }

  // Recursively search nodes in a file tree
  searchNodes(
    node: FigmaNode,
    query: string,
    type?: string,
    results: FigmaNode[] = [],
    maxResults = 50
  ): FigmaNode[] {
    if (results.length >= maxResults) return results;

    const nameMatch = node.name.toLowerCase().includes(query.toLowerCase());
    const typeMatch = !type || node.type.toUpperCase() === type.toUpperCase();

    if (nameMatch && typeMatch && node.type !== "DOCUMENT" && node.type !== "CANVAS") {
      results.push({ id: node.id, name: node.name, type: node.type });
    }

    if (node.children) {
      for (const child of node.children) {
        if (results.length >= maxResults) break;
        this.searchNodes(child, query, type, results, maxResults);
      }
    }

    return results;
  }
}
