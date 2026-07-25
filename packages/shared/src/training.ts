export type TrainingModuleStatus = 'enabled' | 'disabled';

export type TrainingModuleConfigResponse = {
  enabled: boolean;
  status: TrainingModuleStatus;
};
